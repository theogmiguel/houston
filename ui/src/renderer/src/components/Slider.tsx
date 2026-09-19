import { useEffect, useRef, useState } from 'react'
import { BTN_GHOST } from './buttonChrome'
import { Tooltip } from './Tooltip'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  commitOnRelease?: boolean
  formatValue?: (value: number) => string
  disabled?: boolean
  disabledReason?: string
  resetValue?: number
  onReset?: () => void
  'aria-label': string
  className?: string
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  commitOnRelease = false,
  formatValue = (v) => String(v),
  disabled = false,
  disabledReason,
  resetValue,
  onReset,
  className = '',
  ...rest
}: SliderProps): React.JSX.Element {
  const ariaLabel = rest['aria-label']
  const [draft, setDraft] = useState(value)
  const dragging = useRef(false)

  useEffect(() => {
    if (!dragging.current) setDraft(value)
  }, [value])

  const commit = (): void => {
    if (!commitOnRelease || !dragging.current) return
    dragging.current = false
    onChange(draft)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const n = Number(e.target.value)
    if (!Number.isFinite(n)) return
    const clamped = Math.min(max, Math.max(min, n))
    if (commitOnRelease) {
      dragging.current = true
      setDraft(clamped)
    } else {
      setDraft(clamped)
      onChange(clamped)
    }
  }

  const showReset = resetValue !== undefined && !!onReset
  const title = disabled ? disabledReason : undefined

  return (
    <div
      data-testid="slider"
      data-state={disabled ? 'disabled' : 'filled'}
      className={`flex items-center gap-[var(--space-2)] ${className}`}
    >
      <Tooltip label={title} className={disabled ? 'inline-flex' : undefined}>
        <input
          type="range"
          data-testid="slider-input"
          aria-label={ariaLabel}
          className="accent-[var(--accent)] disabled:opacity-50 disabled:cursor-not-allowed"
          min={min}
          max={max}
          step={step}
          value={draft}
          disabled={disabled}
          onChange={handleChange}
          onPointerUp={commit}
          onMouseUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </Tooltip>
      <div
        data-testid="slider-readout"
        className="min-w-[3ch] text-right text-[length:var(--tr-text-small-size)] tabular-nums text-[var(--text-primary)]"
      >
        {formatValue(draft)}
      </div>
      {showReset && (
        <button
          type="button"
          data-testid="slider-reset"
          disabled={value === resetValue}
          onClick={onReset}
          className={`btn ${BTN_GHOST} px-[var(--space-1-5)] py-0 text-[length:var(--tr-text-small-size)] disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          Reset
        </button>
      )}
    </div>
  )
}

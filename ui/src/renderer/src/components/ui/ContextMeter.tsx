import type { ButtonHTMLAttributes } from 'react'
import { RING_ACCENT_ICON } from './shadowChrome'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { HIT_TARGET_28 } from '../hitTarget'

const RADIUS = 5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const TONE = {
  normal: 'text-[var(--text-primary)]',
  warn: 'text-[var(--warn)]',
  danger: 'text-[var(--danger)]'
} as const

export type ContextMeterTone = keyof typeof TONE

/** The pane-header ring that fills with the share of the context window in use; `percent` null draws the empty track. */
export function ContextMeterButton({
  tone,
  percent,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { tone: ContextMeterTone; percent: number | null }): React.JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} flex-none items-center justify-center rounded-[var(--tr-radius-sm)] cursor-pointer hover:bg-[var(--hover-fill)] focus-visible:bg-[var(--hover-fill)] outline-none focus-visible:shadow-[${RING_ACCENT_ICON}] ${TONE[tone]}`}
    >
      <svg data-testid="context-meter" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r={RADIUS} fill="none" stroke="var(--text-muted)" strokeWidth="1.5" />
        {percent != null && (
          <circle
            data-testid="context-meter-value"
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
            transform="rotate(-90 7 7)"
          />
        )}
      </svg>
    </button>
  )
}

export function ContextMeterSpecimen(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-[var(--space-2)]">
      <ContextMeterButton tone="normal" percent={null} aria-label="Context limit unknown" />
      <ContextMeterButton tone="normal" percent={40} aria-label="Context 40% used" />
      <ContextMeterButton tone="warn" percent={88} aria-label="Context almost full" />
      <ContextMeterButton tone="danger" percent={97} aria-label="Context 97% used" />
    </span>
  )
}

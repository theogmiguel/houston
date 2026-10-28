export const FIELD_CLS =
  'h-[var(--h-ctl)] px-[var(--space-2)] bg-[var(--content-bg)] border border-[var(--border)] ' +
  'rounded-[var(--tr-radius-input)] text-[var(--text-primary)] ' +
  'text-[length:var(--tr-text-ui-size)] font-medium'

export const SELECT_CLS =
  'h-[var(--h-pill)] px-[var(--space-2)] bg-[var(--field)] border border-[var(--line-strong)] ' +
  'rounded-[var(--tr-radius-button)] text-[var(--text-primary)] ' +
  'text-[length:var(--tr-text-ui-size)] font-medium ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent-ink)] focus-visible:[outline-offset:2px] ' +
  'disabled:opacity-45 disabled:cursor-not-allowed'

// A property chip in a record header: a hairline-bordered pill that carries its
// own label as a prefix. `!` on the gap and border keeps the trigger layout's
// gap and the open-state border from outranking the chip's own values.

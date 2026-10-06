import { FOCUS_HALO } from './shadowChrome'

export const SEG_TRACK_CLS =
  'inline-flex items-center h-[var(--h-ctl)] p-[2px] max-w-full overflow-x-auto rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]'

export const SEG_ITEM_CLS = `inline-flex flex-none items-center justify-center gap-[var(--space-1)] min-w-[54px] h-[var(--h-ctl-mini)] px-[10px] whitespace-nowrap border-0 rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] motion-safe:transition-[color,background-color] motion-safe:duration-[180ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed`

export const SEG_ITEM_ON_CLS =
  'bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] text-[var(--text-primary)] [font-weight:var(--tr-text-small-weight)]'

export const SEG_ITEM_OFF_CLS =
  'bg-transparent text-[var(--text-secondary)] [font-weight:var(--tr-text-small-weight)] hover:text-[var(--text-primary)]'

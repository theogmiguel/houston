import { RING_ACCENT_INSET_18 } from './shadowChrome'

export const PICKER_LABEL_CLS =
  'block [font-size:var(--tr-text-label-size)] leading-[14px] [text-transform:var(--tr-text-label-transform)] ' +
  '[letter-spacing:var(--tr-text-label-tracking)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)]'

export const TILE_BASE = 'border text-left transition-[border-color,background-color,color] duration-150'

export const TILE_SELECTED =
  '[border-color:var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--card-bg))] ' +
  `shadow-[${RING_ACCENT_INSET_18}]`

export const TILE_IDLE = 'border-[var(--border)] bg-[var(--card-bg)] hover:border-[var(--text-faint)]'

export const TILE_AGENT_CLS =
  'flex h-[30px] items-center gap-[9px] rounded-[var(--tr-radius-button)] pl-[10px] pr-[8px]'

export const BTN_PRIMARY =
  'bg-[var(--accent)] [border-color:var(--accent)] text-white font-bold ' +
  'hover:bg-[var(--accent-hover)]'

// text-white is a fixed contrast pair, not a themed surface: every theme's
// --danger is dark enough (#ef4444/#dc2626) for white to clear 4.5:1, which
// check:css enforces.
export const BTN_DANGER_SOLID =
  'bg-[var(--danger)] [border-color:var(--danger)] text-white font-bold ' +
  'hover:bg-[color-mix(in_srgb,var(--danger)_85%,black)]'

export const BTN_SECONDARY =
  'btn border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] hover:enabled:bg-[var(--hover-fill)] disabled:opacity-55'

// border-none resets border-style (not a transparent border color) -- the
// danger variants below depend on that reset already having zeroed the
// border, so a border-color override alone would paint nothing.
export const BTN_GHOST_BG = 'bg-transparent'

export const BTN_GHOST = `${BTN_GHOST_BG} border-none text-[var(--text-muted)]`

// Signal through fill + text, not border-color: BTN_GHOST above resets
// border-style to none, so a border-color override here would paint nothing.
export const BTN_GHOST_DANGER_HOVER =
  'hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] hover:text-[var(--danger)]'

export const BTN_GHOST_DANGER_ARM =
  'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] font-semibold'

export const BTN_ICO =
  'bg-transparent border-none text-[var(--text-muted)] w-6 h-[var(--h-ctl-mini)] p-0 ' +
  'leading-none inline-flex items-center justify-center flex-none rounded-[var(--tr-radius-sm)] ' +
  'hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] ' +
  '[&_svg]:block [&_svg]:flex-none'

// Subset of BTN_ICO carrying only what no icon-header call site overrides
// (shape, resets, svg pair) -- adding BTN_ICO's own colors here would tie
// with the utilities those sites already layer on top.
export const BTN_ICO_STRUCTURE =
  'border-none p-0 leading-none inline-flex items-center justify-center flex-none ' +
  '[&_svg]:block [&_svg]:flex-none'

export const BELL_GHOST =
  'border-none [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] py-0.5 px-1.5'
export const BELL_ITEM_GHOST =
  'border-none [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] py-px px-1.5'

export const LINK_INLINE =
  'underline text-[var(--accent)] bg-transparent border-0 p-0 font-[inherit] cursor-pointer ' +
  'hover:text-[var(--accent-hover)] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]'

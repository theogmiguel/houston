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

// Background half of the ghost look, for sites that keep their own text colour
// and border (App.tsx's inherit-colour button).
export const BTN_GHOST_BG = 'bg-transparent'

// A component-layer class (base.css) that owns the hover state: call-site
// utilities and the danger variants below win by layer, not by tie-break order.
// Its `border: none` resets border-style, so border-color alone paints nothing.
export const BTN_GHOST = 'btn-ghost'

// Signal through fill + text, not border-color (BTN_GHOST has no border style).
// Utilities outrank BTN_GHOST's component-layer hover, so this wins on its own.
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

export const LINK_INLINE =
  'underline text-[var(--accent)] bg-transparent border-0 p-0 font-[inherit] cursor-pointer ' +
  'hover:text-[var(--accent-hover)] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]'

export type ControlSize = 'regular' | 'small' | 'mini'

// `mini` is a VISIBLE 22px box, not a 22px target: the density rule holds at
// 28px regardless of what a control looks like, so any hand-rolled mini
// control must also carry `HIT_TARGET_28` (`Button` applies it automatically).
export const CONTROL_SIZE_CLS: Readonly<Record<ControlSize, string>> = Object.freeze({
  regular: 'h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-2)]',
  small: 'h-[var(--h-pill)] px-[var(--space-2)] gap-[var(--space-1-5)]',
  mini: 'h-[var(--h-ctl-mini)] px-[var(--space-1)] gap-[var(--space-1)]'
})

export const CONTROL_SIZE_SQUARE_CLS: Readonly<Record<ControlSize, string>> = Object.freeze({
  regular: 'h-[var(--h-ctl)] w-[var(--h-ctl)] p-0',
  small: 'h-[var(--h-pill)] w-[var(--h-pill)] p-0',
  mini: 'h-[var(--h-ctl-mini)] w-[var(--h-ctl-mini)] p-0'
})

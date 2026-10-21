export const FOCUS_HALO_CLS = 'focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--focus-ring)]'
export const FOCUS_WITHIN_HALO_CLS = 'focus-within:shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--focus-ring)]'

// Recipes ship as complete literal utilities: Tailwind only generates a class it can
// read whole in the source, never one assembled from an interpolated constant.
export const FOCUS_RING_ACCENT_ICON_CLS = 'focus-visible:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_50%,transparent)]'

export const RING_ACCENT_SOLID_CLS = 'shadow-[0_0_0_1px_var(--accent)]'

export const FOCUS_HAIRLINE_INSET_CLS = 'focus-visible:shadow-[inset_0_0_0_1px_var(--border)]'

export const AFTER_HAIRLINE_INSET_TRANSPARENT_CLS = 'after:shadow-[inset_0_0_0_1px_transparent]'

export const FOCUS_RING_ACCENT_INSET_45_CLS = 'focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,transparent)]'

export const RING_ACCENT_INSET_18_CLS = 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_18%,transparent)]'

export const GLOW_DANGER_CLS = 'shadow-[0_0_8px_color-mix(in_srgb,var(--danger)_60%,transparent)]'
export const GLOW_WARNING_CLS = 'shadow-[0_0_8px_color-mix(in_srgb,var(--warning)_60%,transparent)]'
export const GLOW_ACCENT_CLS = 'shadow-[0_0_8px_color-mix(in_srgb,var(--accent)_70%,transparent)]'

export const GLOSS_TOP_HIGHLIGHT_CLS = 'shadow-[inset_0_1px_color-mix(in_srgb,#fff_22%,transparent)]'

// Separates a small badge from the hovered card behind it.
export const RING_CARD_HOVER_GAP_CLS = 'shadow-[0_0_0_2px_var(--card-hover)]'

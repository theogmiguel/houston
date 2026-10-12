export const ROW_STATE = {
  rest: 'bg-transparent text-[var(--text-secondary)] hover:bg-hover-fill',
  selected: 'bg-selected-fill text-[var(--text-primary)] hover:bg-selected-hover-fill'
} as const

// Pointer and keyboard share an active index in searchable lists; CSS hover must not paint a second row.
export const ROW_HIGHLIGHT = {
  rest: ROW_STATE.rest.split(' ').filter((cls) => !cls.startsWith('hover:')).join(' '),
  selected: ROW_STATE.selected.split(' ').filter((cls) => !cls.startsWith('hover:')).join(' ')
} as const

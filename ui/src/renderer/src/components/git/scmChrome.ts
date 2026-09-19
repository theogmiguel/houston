import { MATERIAL_CLS, materialAttrs } from '../material'

export const SECTION_HEAD_CLS =
  'flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tracking-[0.1em] uppercase text-[var(--text-muted)]'

export const SCM_ROW_CLS =
  'group/row relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)] hover:bg-[var(--hover-fill)]'

export const SCM_CARD_CLS = `${MATERIAL_CLS.inset} rounded-[var(--tr-radius-sm)] overflow-hidden`

export const SCM_CARD_ATTRS = materialAttrs('inset')

export const META_ROW_CLS =
  'flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] border-t border-t-[var(--divider)] first:border-t-0 text-[length:var(--tr-text-small-size)]'

export const MARK_TONE: Readonly<Record<string, string>> = Object.freeze({
  modified: 'text-[var(--warn)]',
  added: 'text-[var(--ok)]',
  deleted: 'text-[var(--stop)]',
  renamed: 'text-[var(--info)]',
  untracked: 'text-[var(--info)]',
  conflicted: 'text-[var(--warn)]',
  staged: 'text-[var(--ok)]',
  unstaged: 'text-[var(--text-muted)]',
  conflict: 'text-[var(--warn)]',
  blocked: 'text-[var(--danger)]'
})

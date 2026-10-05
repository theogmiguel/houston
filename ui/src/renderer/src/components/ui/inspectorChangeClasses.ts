import { BTN_GHOST } from '../buttonChrome'
import { RING_ACCENT_ICON, RING_ACCENT_INSET_45 } from '../shadowChrome'
import { HIT_TARGET_28 } from '../hitTarget'

const SECTION_HEAD_CLS = 'flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tracking-[0.1em] uppercase text-[var(--text-muted)]'
const SCM_ROW_CLS = 'group/row relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)] hover:bg-[var(--hover-fill)]'

export const changeFileClasses = {
  list: 'min-h-0 overflow-y-auto [scrollbar-width:thin] py-1 focus-visible:outline-none focus-visible:shadow-[' + RING_ACCENT_INSET_45 + ']',
  bulk: `btn ${BTN_GHOST} h-[var(--h-ctl-mini)] px-[var(--space-1-5)] text-[length:var(--tr-text-xs)] normal-case tracking-normal`,
  groupCount: 'ml-auto font-mono font-medium text-[length:var(--tr-text-xs)] text-[var(--text-faint)] tabular-nums',
  stage: `flex-none w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] grid place-items-center text-[var(--text-faint)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${RING_ACCENT_ICON}]`,
  field: 'flex-1 min-w-0 flex items-center gap-2 bg-transparent border-0 p-0 text-left text-inherit',
  glyph: 'changes-file-glyph',
  label: 'changes-file-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[length:var(--tr-text-xs)]',
  dir: 'text-[var(--text-faint)]',
  counts: 'flex-none min-w-[52px] text-right font-mono text-[length:var(--tr-text-xs)] font-medium tabular-nums',
  emptyCounts: 'flex-none min-w-[52px] text-right font-mono text-[length:var(--tr-text-xs)] text-[var(--text-faint)]',
  menuButton: `flex-none w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] grid place-items-center text-[var(--text-faint)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${RING_ACCENT_ICON}] ${HIT_TARGET_28}`,
  rowMenu: 'absolute right-1 top-[var(--h-row)] z-[var(--z-sticky)] min-w-[170px] flex flex-col rounded-[var(--tr-radius-sm)] py-[var(--space-1)]',
  menuItem: 'text-left px-2.5 py-1 text-[length:var(--tr-text-sm)] bg-transparent border-0 disabled:opacity-45 disabled:cursor-not-allowed flex items-center gap-[var(--space-1-5)]',
  added: 'text-[var(--ok)]',
  deleted: 'text-[var(--danger)]'
}

export function changeGroupHeadingClass(group: string): string {
  return `changes-group-head ${SECTION_HEAD_CLS} ${group === 'conflicted' ? 'text-[var(--warn)]' : ''}`
}

export function changeRowClass(selected: boolean): string {
  return `changes-file-row ${SCM_ROW_CLS} ${selected ? 'bg-[var(--selected-fill)] text-[var(--text-primary)]' : ''}`
}

export function changeMarkClass(tone: string): string {
  return `changes-file-mark flex-none w-[14px] text-center font-mono text-[length:var(--tr-text-xs)] [font-weight:var(--tr-text-label-weight)] ${tone}`
}

export function changeStatusClass(tone: string): string {
  return `changes-file-status font-mono ${tone}`
}

export function changeMenuItemClass(danger: boolean): string {
  return `${changeFileClasses.menuItem} ${danger ? 'text-[var(--danger)] enabled:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]' : 'text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)]'}`
}

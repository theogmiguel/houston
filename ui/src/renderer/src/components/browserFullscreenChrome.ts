import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { FOCUS_HALO } from './shadowChrome'

export const FS_BACKDROP_CLS =
  'fixed inset-0 z-[var(--z-tooltip)] flex ' +
  '[padding:clamp(10px,2.5vh,28px)_clamp(10px,2.5vw,32px)] ' +
  'bg-[color-mix(in_srgb,#000_58%,transparent)] [backdrop-filter:blur(2px)] ' +
  'motion-safe:animate-[backdrop-in_0.14s_ease-out]'

const FS_FOCUS_RING_CLS =
  '[&_:focus-visible]:outline [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-[var(--text-primary)] [&_:focus-visible]:outline-offset-2 [&_:focus-visible]:rounded-[var(--tr-radius-sm)]'

export const FS_MODAL_CLS =
  'relative flex-1 min-w-0 min-h-0 flex flex-col ' +
  'bg-background border border-border rounded-[12px] pt-0 px-1 pb-1 overflow-hidden ' +
  'shadow-[var(--shadow-2)] outline-none ' +
  'motion-safe:animate-[panel-in_0.17s_cubic-bezier(0.22,0.8,0.2,1)] ' +
  FS_FOCUS_RING_CLS

export const FS_CHROME_CLS = 'flex-shrink-0 mx-[-4px] bg-background'

export const FS_ROW_CLS =
  'h-[42px] min-h-[42px] flex items-center justify-center gap-[6px] px-3'

export const FS_NAV_BTN_CLS =
  `inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] text-[var(--text-muted)] bg-transparent border-0 flex-none [transition:color_0.14s_ease,background_0.14s_ease,transform_0.14s_ease] enabled:hover:text-[var(--text-primary)] enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] enabled:active:scale-[0.92] disabled:opacity-[0.28] disabled:cursor-default`

export const FS_URL_WRAP_CLS = 'flex-[0_1_720px] flex min-w-0'

export const FS_URL_INPUT_CLS =
  'flex-1 min-w-0 h-[var(--h-ctl)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] rounded-[8px] border border-border ' +
  `bg-[var(--tool-code-bg)] text-[var(--text-secondary)] px-2.5 outline-none focus-visible:shadow-[${FOCUS_HALO}] cursor-default`

export const FS_EXIT_BTN_CLS =
  `inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] flex-none border-0 ` +
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] ' +
  'hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)] ' +
  '[transition:background_0.14s_ease,color_0.14s_ease,transform_0.14s_ease] active:scale-[0.92]'

export const FS_SLOT_CLS = 'flex-1 min-w-0 min-h-0 flex rounded-b-[8px] overflow-hidden'

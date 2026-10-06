import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { HIT_TARGET_28 } from '../hitTarget'

export {
  BackBar,
  ContentColumn,
  DetailState,
  EmptyPane,
  FeedbackBanner,
  FieldSwitch,
  SupportingNote,
  BackBar as NavBack,
  ContentColumn as NavColumn,
  DetailState as NavDetailState,
  EmptyPane as NavEmpty,
  FeedbackBanner as NavFeedback,
  SupportingNote as NavFootnote,
  FieldSwitch as NavSwitch
} from '../ui/navPrimitives'

export const BLOCK =
  'overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card-bg)]'

const ROW_BASE =
  'group/row relative px-[14px] py-[11px] [&+&]:border-t [&+&]:border-t-[var(--divider)] hover:bg-[var(--hover-fill)] focus-within:bg-[var(--hover-fill)]'
export const ROW_TOP = `${ROW_BASE} flex items-start gap-[12px]`
export const ROW = `${ROW_BASE} flex items-center gap-[12px]`
export const ROW_STACK = `${ROW_BASE} block`

export const ROW_TILE =
  'flex-none inline-flex items-center justify-center w-[34px] h-[34px] rounded-[var(--tr-radius-sm)] bg-[var(--hover-fill)] text-[var(--text-secondary)]'

export const ROW_TITLE =
  'truncate [font-size:var(--tr-text-ui-size)] font-semibold leading-[1.35] text-[var(--text-primary)]'

export const ROW_DETAIL =
  'truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.35] text-[var(--text-secondary)]'

export const ROW_ACTIONS =
  'ml-auto flex items-center gap-[2px] opacity-0 [transition:opacity_0.1s_ease-out] group-hover/row:opacity-100 group-focus-within/row:opacity-100'
export const ROW_FOOTER =
  'flex items-center min-h-[24px] mt-[2px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]'

const BUTTON_BASE =
  'btn inline-flex items-center justify-center gap-[7px] min-h-[var(--h-ctl)] px-[12px] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default'
export const PRIMARY_BUTTON = `${BUTTON_BASE} border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-55`
export const SECONDARY_BUTTON = `${BUTTON_BASE} border border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55`

export const CHROME_BUTTON =
  `btn inline-flex items-center justify-center flex-none ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_0.1s_ease-out,background-color_0.1s_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--text-primary)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default`
export const CHROME_BUTTON_DANGER = `${CHROME_BUTTON} hover:not-disabled:text-[var(--danger)]!`

export const FIELD_LABEL = 'block mb-[7px] [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]'
export const FIELD_INPUT =
  'w-full h-[36px] px-[12px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]'
export const FIELD_TEXTAREA =
  'w-full min-h-[88px] resize-y px-[12px] py-[9px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.5] text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]'

export function chipClass(pressed: boolean): string {
  return `btn min-h-[var(--h-ctl)] px-[9px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default disabled:opacity-60 ${
    pressed
      ? 'bg-[var(--selected-fill)] font-semibold text-[var(--text-primary)]'
      : 'bg-[var(--hover-fill)] font-medium text-[var(--text-secondary)] hover:not-disabled:bg-[var(--selected-fill)] hover:not-disabled:text-[var(--text-primary)]'
  }`
}

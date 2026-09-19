import { FOCUS_HALO, GLOW_ACCENT } from './shadowChrome'

export const PICKER_HINT_CLS =
  'flex items-center gap-2 pt-1.5 pr-1.5 pb-1.5 pl-2.5 min-h-[32px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ' +
  'text-[color-mix(in_srgb,var(--text-primary)_80%,var(--accent)_10%)] border-t border-border flex-none'

export const PICKER_DOT_CLS =
  'loop-anim w-1.5 h-1.5 rounded-full bg-[var(--accent)] ' +
  `shadow-[${GLOW_ACCENT}] flex-none [--dot-pulse-opacity:0.45] [--dot-pulse-scale:0.82] ` +
  'motion-safe:animate-[dot-pulse-scale_1.8s_ease-in-out_infinite]'

export const PICKER_HINT_TEXT_CLS = 'flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis'

export const PICKER_STATUS_HINT_CLS =
  'ml-auto pr-1 text-[color-mix(in_srgb,var(--text-muted)_85%,transparent)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] italic ' +
  'whitespace-nowrap overflow-hidden text-ellipsis'

export const PICKER_SELROW_CLS = 'flex items-center gap-[7px] py-1.5 px-2.5 border-t border-border min-w-0 flex-none'

export const PICKER_TAG_CLS =
  'font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] ' +
  'rounded-[4px] py-px px-[5px] flex-none'

export const PICKER_COMP_CLS = '[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-primary overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1'

export const PICKER_INPUTROW_CLS = 'flex items-center gap-1.5 pt-2 pr-2.5 pb-2.5 pl-2.5 border-t border-border flex-none'

export const PICKER_PROMPT_INPUT_CLS =
  `flex-1 min-w-0 h-[var(--h-ctl)] rounded-[8px] border border-border bg-surface text-text-primary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] px-2.5 outline-none focus-visible:shadow-[${FOCUS_HALO}] ` +
  'placeholder:text-text-muted'

export const PICKER_AGENT_SELECT_CLS =
  'h-[var(--h-ctl)] rounded-[8px] border border-border bg-surface text-text-primary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] px-2 flex-none'

const PICKER_SUBMIT_GLOSS = 'inset_0_1px_color-mix(in_srgb,#fff_22%,transparent)'

export const PICKER_SUBMIT_CLS =
  'h-[var(--h-ctl)] px-3 border-0 rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] font-semibold text-white flex-none cursor-pointer ' +
  'bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_100%,white_8%)_0%,var(--accent)_100%)] ' +
  `shadow-[${PICKER_SUBMIT_GLOSS}] disabled:opacity-50 disabled:cursor-default`

export const PICKER_ERROR_CLS =
  'flex items-center gap-2 py-[6px] pr-3 pl-4 flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ' +
  'text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] ' +
  'border-t border-[color-mix(in_srgb,var(--danger)_28%,transparent)] z-[var(--z-base)]'

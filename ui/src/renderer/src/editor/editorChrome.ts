export const EHOST_WRAP_CLS = 'flex-1 min-w-0 min-h-0 relative overflow-hidden'

export const EHOST_CLS = 'absolute inset-0 [&_.cm-editor]:h-full'

export const EDOT_CLS = 'flex-none w-[7px] h-[7px] rounded-full bg-[var(--warning)]'

const ESTATUS_BASE = 'py-1 px-2.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] border-b border-[var(--border)] flex-none cursor-default'

export const ESTATUS_CLS = `${ESTATUS_BASE} text-[var(--text-muted)]`

export const ESTATUS_ERR_CLS = `${ESTATUS_BASE} text-[var(--status-blocked-text)] bg-[var(--status-blocked-bg)]`

export const EPREVIEW_WRAP_CLS =
  'absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 py-0 text-center'
export const EPREVIEW_TITLE_CLS = 'max-w-[320px] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]'
export const EPREVIEW_NAME_CLS = 'max-w-[320px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)] break-all'
export const EPREVIEW_DETAIL_CLS = 'max-w-[320px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-relaxed text-[var(--text-faint)]'

export const EMEDIA_WRAP_CLS = 'absolute inset-0 overflow-auto flex items-center justify-center p-6'
export const EMEDIA_IMG_CLS = 'max-w-full max-h-full object-contain'
export const EMEDIA_VIDEO_CLS = 'max-w-full max-h-full outline-none'
export const EMEDIA_AUDIO_WRAP_CLS = 'flex flex-col items-center gap-3 w-full max-w-md'
export const EMEDIA_AUDIO_CLS = 'w-full outline-none'

export const EMD_WRAP_CLS = 'absolute inset-0 overflow-auto'
export const EMD_PAGE_CLS = 'mx-auto max-w-4xl px-8 py-6'

export const EMD_BODY_CLS = [
  '[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-relaxed text-[var(--text-secondary)]',
  '[&_h1]:[font-size:var(--tr-text-heading-size)] [&_h2]:[font-size:var(--tr-text-subhead-size)] [&_h3]:[font-size:var(--tr-text-body-size)] [&_h4]:[font-size:var(--tr-text-ui-size)]',
  '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold',
  '[&_h1]:text-[var(--text-primary)] [&_h2]:text-[var(--text-primary)] [&_h3]:text-[var(--text-primary)] [&_h4]:text-[var(--text-primary)]',
  '[&_h1]:mt-6 [&_h2]:mt-6 [&_h3]:mt-5 [&_h4]:mt-4 [&_h1]:mb-3 [&_h2]:mb-3 [&_h3]:mb-2 [&_h4]:mb-2',
  '[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0',
  '[&_h1]:border-b [&_h1]:border-[var(--border)] [&_h1]:pb-2',
  '[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:pl-5 [&_ol]:pl-5',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-1',
  '[&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_strong]:text-[var(--text-primary)] [&_em]:italic',
  '[&_code]:font-mono [&_code]:[font-size:var(--tr-text-small-size)] [&_code]:[font-weight:var(--tr-text-small-weight)] [&_code]:rounded-[4px] [&_code]:px-1 [&_code]:py-px',
  '[&_code]:bg-[color-mix(in_srgb,var(--card-bg)_70%,transparent)] [&_code]:text-[var(--text-primary)]',
  '[&_pre]:my-3 [&_pre]:p-3 [&_pre]:rounded-[var(--tr-radius-md)] [&_pre]:overflow-x-auto',
  '[&_pre]:bg-[var(--card-bg)] [&_pre]:border [&_pre]:border-[var(--border)]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-3 [&_blockquote]:pl-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border)] [&_blockquote]:text-[var(--text-muted)]',
  '[&_hr]:my-5 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[var(--border)]',
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:[font-size:var(--tr-text-small-size)] [&_table]:[font-weight:var(--tr-text-small-weight)]',
  '[&_th]:border [&_td]:border [&_th]:border-[var(--border)] [&_td]:border-[var(--border)]',
  '[&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:text-left [&_th]:font-semibold',
  '[&_th]:text-[var(--text-primary)] [&_th]:bg-[color-mix(in_srgb,var(--card-bg)_50%,transparent)]',
  '[&_img]:max-w-full [&_del]:line-through'
].join(' ')

export const EMD_TOGGLE_CLS =
  'inline-flex items-center gap-1 px-1.5 py-0.5 flex-none rounded-[var(--tr-radius-sm)] border-none ' +
  '[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[var(--track-label)] ' +
  'bg-[color-mix(in_srgb,var(--card-bg)_60%,transparent)] text-[var(--text-secondary)] ' +
  'hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]'

export const MD_TOGGLE_COPY = {
  preview: { action: 'Edit source', label: 'Edit' },
  edit: { action: 'Preview', label: 'Preview' }
} as const

export const CONFLICT_MESSAGE = "File changed on disk — your save didn't go through."

export const ECTX_MENU_CLS =
  'ctx-menu fixed z-[var(--z-overlay)] min-w-[180px] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)]'
export const ECTX_ITEM_CLS =
  'ctx-item border-none flex items-center justify-between gap-[14px] w-full py-[5px] px-2.5 rounded-[var(--tr-radius-input)] bg-transparent text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'
export const ECTX_SEP_CLS = 'ctx-sep h-px bg-[var(--border)] my-1 mx-1.5 flex-none'

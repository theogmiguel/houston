import './tagPopoverChrome.css'

export const TAG_POPOVER_CLS = {
  affordance: 'inline-flex h-6 items-center gap-1 rounded px-1 [font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--focus-halo)]',
  prompt: 'fixed z-[var(--z-context)] w-[288px] rounded-[var(--tr-radius-md)] border border-[var(--border-hover)] bg-[var(--raised)] p-3 text-[var(--text-primary)] shadow-[var(--shadow-2)]',
  promptTitle: 'tag-popover-prompt-title text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)] font-semibold',
  promptCopy: '[font-size:var(--tr-text-sm)] leading-relaxed text-[var(--text-secondary)]',
  promptPreview: 'tag-popover-prompt-preview flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--content-bg)] px-2 py-2 [font-size:var(--tr-text-sm)] leading-4',
  promptPreviewLabel: 'text-[var(--text-muted)]',
  promptSwatches: 'ml-auto flex items-center gap-1',
  promptSwatch: 'grid size-5 place-items-center rounded',
  promptActions: 'tag-popover-prompt-actions flex justify-end gap-2',
  dialog: 'fixed z-[var(--z-context)] overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border-hover)] bg-[var(--raised)] py-1 text-[var(--text-primary)] shadow-[var(--shadow-2)]',
  dialogAnimation: 'motion-safe:animate-[menu-in_150ms_var(--motion-menu-ease)]',
  viewAnimation: 'motion-safe:animate-[popover-view-in_var(--motion-menu-t)_var(--motion-menu-ease)_both]',
  pickList: 'max-h-[var(--h-tags-pick-list-max)] overflow-auto p-[var(--space-1)]',
  emptyPick: 'px-2 py-3 text-center text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]',
  divider: 'mx-2 border-t border-[var(--border)]',
  menuAction: 'flex h-8 w-full items-center gap-2 px-3 text-left text-[length:var(--tr-text-ui-size)] hover:bg-[var(--surface-hover)]',
  pickRow: 'flex w-full items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] px-[var(--space-2)] h-8 text-left text-[length:var(--tr-text-ui-size)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[var(--focus-halo)]',
  selected: 'bg-[var(--selected-fill)]',
  tagName: 'min-w-0 flex-1 truncate text-[length:var(--tr-text-ui-size)]',
  manageName: 'min-w-0 flex-1 truncate text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)]',
  header: 'flex h-10 items-center gap-2 border-b border-[var(--border)] px-2',
  backButton: 'grid size-7 place-items-center rounded hover:bg-[var(--surface-hover)]',
  title: 'truncate text-[length:var(--tr-text-ui-size)]',
  manageTitle: 'flex-1 text-[length:var(--tr-text-ui-size)]',
  body: 'grid gap-3 p-3',
  nameInput: 'h-8 rounded border border-[var(--border)] bg-[var(--content-bg)] px-2 text-[length:var(--tr-text-ui-size)] outline-none focus:border-[var(--accent)] focus-visible:shadow-[var(--focus-halo)]',
  fieldLabel: 'tag-popover-field-label text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]',
  swatchList: 'flex flex-wrap gap-2',
  colorSwatch: 'size-5 rounded-full',
  colorSwatchSelected: 'outline outline-1 outline-offset-2 outline-[var(--text-primary)]',
  customColor: 'grid size-5 place-items-center rounded-full border border-[var(--border)] [font-size:var(--tr-text-sm)] leading-4',
  customColorWrap: 'grid overflow-hidden transition-[grid-template-rows] duration-150',
  customColorExpanded: 'grid-rows-[1fr]',
  customColorCollapsed: 'grid-rows-[0fr]',
  crop: 'min-h-0 overflow-hidden',
  colorEditor: 'grid gap-2 rounded border border-[var(--border)] p-2',
  colorValueRow: 'flex items-center gap-2',
  colorPreview: 'size-4 rounded border border-[var(--border)]',
  hexInput: 'h-7 min-w-0 flex-1 bg-transparent font-mono [font-size:var(--tr-text-sm)] leading-4 outline-none focus-visible:shadow-[var(--focus-halo)]',
  error: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--stop)]',
  previewRow: 'flex items-center justify-between',
  quietText: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)]',
  warning: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--warning)]',
  actions: 'flex items-center justify-end gap-2',
  reason: 'mr-auto [font-size:var(--tr-text-sm)] leading-4 text-[var(--stop)]',
  colorPicker: 'relative touch-none cursor-crosshair rounded',
  colorPickerHeight: 'h-36',
  colorPickerInlineHeight: 'h-24',
  colorPickerCompact: 'h-3 touch-none rounded-full',
  colorPickerFull: 'relative h-3 touch-none cursor-pointer rounded-full',
  pickerMarker: 'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white',
  pickerMarkerShadow: 'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow',
  hueMarker: 'absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow',
  manageList: 'max-h-[var(--h-tags-manage-list-max)] overflow-auto p-1',
  undoRow: 'flex h-9 items-center gap-2 px-2 [font-size:var(--tr-text-sm)] leading-4',
  emptyManage: 'py-5 text-center [font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)]',
  rowHighlight: 'bg-[var(--selected-fill)]',
  manageRow: 'group flex h-9 items-center gap-2 px-2',
  usage: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)] group-hover:hidden group-focus-within:hidden',
  rowActions: 'hidden items-center gap-1 group-hover:flex group-focus-within:flex',
  rowIconButton: 'grid size-7 place-items-center rounded hover:bg-[var(--surface-hover)]',
  rowDeleteButton: 'grid size-7 place-items-center rounded text-[var(--stop)] hover:bg-[var(--surface-hover)]',
  deleteConfirm: 'flex items-center gap-1 px-2 py-2 [font-size:var(--tr-text-sm)] leading-4',
  inlineEdit: 'border-y border-[var(--border)]',
  inlineBody: 'grid gap-2 p-2',
  inlineNameInput: 'h-8 rounded border border-[var(--border)] bg-[var(--content-bg)] px-2 text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)]',
  inlineHexInput: 'h-7 rounded border border-[var(--border)] bg-transparent px-2 font-mono [font-size:var(--tr-text-sm)] leading-4',
  inlineActions: 'flex justify-end gap-2',
} as const

export function tagPopoverWidthClass(view: 'pick' | 'edit' | 'manage'): string {
  if (view === 'pick') return 'w-[232px]'
  if (view === 'edit') return 'w-[264px]'
  return 'w-[272px]'
}

export function tagPopoverPickerMarkerClass(shadow = false): string {
  return shadow ? TAG_POPOVER_CLS.pickerMarkerShadow : TAG_POPOVER_CLS.pickerMarker
}

export function tagPopoverHuePickerClass(compact: boolean): string {
  return compact ? TAG_POPOVER_CLS.colorPickerCompact : TAG_POPOVER_CLS.colorPickerFull
}

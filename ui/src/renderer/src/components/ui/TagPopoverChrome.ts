import './floatingSurface.css'
import './tagPopoverChrome.css'

export const TAG_POPOVER_CLS = {
  closing: 'tag-popover-closing',
  cardIcon: 'tag-card-icon',
  cardDots: 'tag-card-dots',
  cardChips: 'tag-card-chips',
  cardChip: 'tag-card-chip',
  cardDot: 'tag-card-dot',
  cardMore: 'tag-card-more',
  affordance: 'inline-flex items-center text-[var(--text-muted)] focus-visible:outline-none focus-visible:shadow-[var(--focus-halo)]',
  prompt: 'tag-popover-prompt floating-glass fixed z-[var(--z-context)] text-[var(--text-primary)]',
  promptTitle: 'tag-popover-prompt-title text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)] font-semibold',
  promptCopy: '[font-size:var(--tr-text-sm)] leading-relaxed text-[var(--text-secondary)]',
  promptPreview: 'tag-popover-prompt-preview flex items-center gap-1',
  promptPreviewLabel: 'text-[var(--text-muted)]',
  promptSwatches: 'ml-auto flex items-center gap-1',
  promptSwatch: 'tag-popover-prompt-swatch',
  promptActions: 'tag-popover-prompt-actions flex justify-end gap-2',
  dialog: 'tag-popover-dialog floating-glass fixed z-[var(--z-context)] overflow-hidden text-[var(--text-primary)]',
  dialogAnimation: 'tag-popover-opening',
  viewAnimation: 'tag-popover-view-motion',
  pickList: 'tag-popover-pick-list overflow-auto',
  emptyPick: 'tag-popover-empty text-[var(--text-muted)]',
  divider: 'tag-popover-divider',
  menuAction: 'tag-popover-menu-action flex w-full items-center text-left focus-visible:outline-none focus-visible:shadow-[var(--focus-halo)]',
  pickRow: 'tag-popover-pick-row flex w-full items-center text-left focus-visible:outline-none focus-visible:shadow-[var(--focus-halo)]',
  selected: 'tag-popover-highlight',
  tagName: 'min-w-0 flex-1 truncate text-[length:var(--tr-text-ui-size)]',
  manageName: 'min-w-0 flex-1 truncate text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)]',
  header: 'tag-popover-header flex items-center',
  backButton: 'tag-popover-back grid place-items-center hover:bg-[var(--hover-fill)]',
  title: 'truncate text-[length:var(--tr-text-ui-size)]',
  manageTitle: 'flex-1 text-[length:var(--tr-text-ui-size)]',
  body: 'tag-popover-body grid',
  nameInput: 'tag-popover-input outline-none focus-visible:shadow-[var(--focus-halo)]',
  fieldLabel: 'tag-popover-field-label text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]',
  swatchList: 'tag-popover-swatches flex flex-wrap',
  colorSwatch: 'tag-popover-swatch rounded-full',
  colorSwatchSelected: 'tag-popover-swatch-selected',
  customColor: 'tag-popover-swatch tag-popover-custom-color grid place-items-center rounded-full',
  customColorWrap: 'grid overflow-hidden transition-[grid-template-rows] duration-150',
  customColorExpanded: 'grid-rows-[1fr]',
  customColorCollapsed: 'grid-rows-[0fr]',
  crop: 'min-h-0 overflow-hidden',
  colorEditor: 'tag-popover-color-editor grid',
  colorValueRow: 'tag-popover-hex-row flex items-center',
  colorPreview: 'tag-popover-color-preview flex-none',
  hexInput: 'tag-popover-hex-input min-w-0 flex-1 font-mono outline-none focus-visible:shadow-[var(--focus-halo)]',
  error: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--stop)]',
  previewRow: 'tag-popover-preview-row flex items-center',
  quietText: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)]',
  warning: 'flex items-center gap-[var(--space-1)] [font-size:var(--tr-text-xs)] leading-4 text-[var(--warn)]',
  actions: 'tag-popover-actions flex items-center justify-end',
  reason: 'mr-auto [font-size:var(--tr-text-sm)] leading-4 text-[var(--stop)]',
  colorPicker: 'relative touch-none cursor-crosshair rounded',
  colorPickerHeight: 'h-[var(--h-tag-color-picker)]',
  colorPickerInlineHeight: 'h-24',
  colorPickerCompact: 'h-3 touch-none rounded-full',
  colorPickerFull: 'relative h-3 touch-none cursor-pointer rounded-full',
  pickerMarker: 'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white',
  pickerMarkerShadow: 'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow',
  hueMarker: 'absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow',
  manageList: 'tag-popover-manage-list overflow-auto',
  undoRow: 'flex h-9 items-center gap-2 px-2 [font-size:var(--tr-text-sm)] leading-4',
  emptyManage: 'py-5 text-center [font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)]',
  rowHighlight: 'tag-popover-highlight',
  manageRow: 'tag-popover-manage-row group flex items-center',
  usage: '[font-size:var(--tr-text-sm)] leading-4 text-[var(--text-muted)] group-hover:hidden group-focus-within:hidden',
  rowActions: 'hidden items-center gap-1 group-hover:flex group-focus-within:flex',
  rowIconButton: 'grid size-7 place-items-center rounded hover:bg-[var(--surface-hover)]',
  rowDeleteButton: 'grid size-7 place-items-center rounded text-[var(--stop)] hover:bg-[var(--surface-hover)]',
  deleteConfirm: 'flex items-center gap-1 px-2 py-2 [font-size:var(--tr-text-sm)] leading-4',
  inlineEdit: 'border-y border-[var(--border)]',
  inlineBody: 'tag-popover-inline-body grid',
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

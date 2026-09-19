export type Material =
  | 'base'
  | 'shell'
  | 'inset'
  | 'raised'
  | 'raised-glass'
  | 'overlay'
  | 'overlay-glass'

const GLASS_FILM =
  '[-webkit-backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))] ' +
  '[backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))]'

export const MATERIAL_CLS: Readonly<Record<Material, string>> = Object.freeze({
  base: 'bg-[var(--material-base-bg)]',
  shell: 'bg-[var(--material-shell-bg)]',
  inset: 'bg-[var(--material-inset-bg)] border border-[var(--material-inset-brd)]',
  raised:
    'bg-[var(--material-raised-bg)] border border-[var(--material-raised-brd)] ' +
    'shadow-[var(--material-raised-shadow)]',
  'raised-glass':
    `${GLASS_FILM} bg-[var(--material-raised-glass-bg)] ` +
    'border border-[var(--material-raised-glass-brd)] shadow-[var(--material-raised-shadow)]',
  overlay:
    'bg-[var(--material-overlay-bg)] border border-[var(--material-overlay-brd)] ' +
    'shadow-[var(--material-overlay-shadow)]',
  'overlay-glass':
    `${GLASS_FILM} bg-[var(--material-overlay-glass-bg)] ` +
    'border border-[var(--material-overlay-glass-brd)] shadow-[var(--material-overlay-shadow)]'
})

export const MATERIALS = Object.freeze(Object.keys(MATERIAL_CLS)) as readonly Material[]

export function materialAttrs(material: Material): { 'data-material': Material } {
  return { 'data-material': material }
}

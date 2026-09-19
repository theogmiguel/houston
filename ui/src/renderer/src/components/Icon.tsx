import { TIGHT_ICON_MAP, type IconComponent } from './icons'
import type { TextRole } from './Text'

const TIGHT_ROLES: ReadonlySet<TextRole> = new Set(['label', 'small', 'ui'])

const ICON_STRUCTURE_CLS = 'block flex-none'

export const ICON_ROLE_CLS: Readonly<Record<TextRole, string>> = Object.freeze({
  display:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-display-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-display-stroke)]',
  title:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-title-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-title-stroke)]',
  heading:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-heading-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-heading-stroke)]',
  subhead:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-subhead-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-subhead-stroke)]',
  body:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-body-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-body-stroke)]',
  ui:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-ui-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-ui-stroke)]',
  small:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-small-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-small-stroke)]',
  label:
    `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-label-size)] [width:1em] [height:1em] ` +
    '[stroke-width:var(--tr-icon-label-stroke)]'
})

export function resolveTightGlyph(Glyph: IconComponent, role: TextRole): IconComponent {
  return (TIGHT_ROLES.has(role) && TIGHT_ICON_MAP.get(Glyph)) || Glyph
}

export interface IconRenderProps {
  glyph: IconComponent
  role?: TextRole
  label?: string
  className?: string
}

export function Icon({
  glyph: Glyph,
  role = 'ui',
  label,
  className
}: IconRenderProps): React.JSX.Element {
  const base = ICON_ROLE_CLS[role]
  const Resolved = resolveTightGlyph(Glyph, role)
  return (
    <Resolved
      className={className ? `${base} ${className}` : base}
      {...(label != null ? { role: 'img', 'aria-label': label } : {})}
    />
  )
}

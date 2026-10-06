import type { ReactNode } from 'react'
import type { IconComponent, IconProps } from '../icons'
import { ICON_ROLE_CLS } from './Icon'
import { Text } from './Text'
/** The dashed overlay shown while files are dragged over, or copied into, the terminal. */
export function TerminalDropzone({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="term-dropzone absolute inset-[var(--space-1-5)] z-[calc(var(--z-pane)+2)] flex items-center justify-center gap-[var(--space-2)] border-2 border-dashed [border-color:var(--accent)] rounded-[var(--tr-radius-md)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] pointer-events-none motion-safe:[animation:term-enter_var(--animate-t-fast)_var(--animate-ease-panel)]"
      aria-hidden="true"
    >
      {children}
    </div>
  )
}

export function DropzoneIcon({ glyph: Glyph, tone, ...rest }: { glyph: IconComponent; tone: 'busy' | 'image' | 'file' } & IconProps): React.JSX.Element {
  const state = tone === 'busy'
    ? 'text-primary loop-anim motion-safe:animate-[git-spin_0.9s_linear_infinite]'
    : tone === 'image'
      ? 'text-info'
      : 'text-primary'
  return <Glyph {...rest} className={`${ICON_ROLE_CLS.ui} ${state}`} />
}

export function DropzoneLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text tabular size="small" weight="semibold" tone="accent">{children}</Text>
}

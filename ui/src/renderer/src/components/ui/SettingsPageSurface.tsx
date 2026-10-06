import type { ReactNode, Ref } from 'react'
import { materialAttrs, MATERIAL_CLS } from './material'
import { Text } from './Text'

export function SettingsPageSurface({ children, className = '', ref }: { children: ReactNode; className?: string; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div ref={ref} {...materialAttrs('base')} className={`rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base} ${className}`}>{children}</div>
}

export function SettingsPageSurfaceSpecimen(): React.JSX.Element {
  return <SettingsPageSurface className="min-h-[var(--h-row)] p-[var(--space-2)]"><Text size="small" weight="small" tone="muted">Settings page surface</Text></SettingsPageSurface>
}

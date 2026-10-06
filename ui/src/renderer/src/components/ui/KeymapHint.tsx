import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { MATERIAL_CLS, materialAttrs } from './material'

export function KeymapHintSurface({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      {...rest}
      {...materialAttrs('overlay-glass')}
      className={`pointer-events-none fixed left-1/2 bottom-[var(--space-5)] z-[var(--z-modal)] -translate-x-1/2 w-[var(--w-prefix-hint)] max-w-[var(--w-prefix-hint-viewport)] rounded-[var(--tr-radius-md)] ${MATERIAL_CLS['overlay-glass']} flex flex-col gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)]`}
    >
      {children}
    </div>
  )
}

export function KeymapHintHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="label" weight="label" className="text-accent">{children}</Text>
}

export function KeymapHintGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(var(--w-prefix-hint-group-min),1fr))] gap-x-[var(--space-4)] gap-y-[var(--space-2)]">{children}</div>
}

export function KeymapHintGroup({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <Text as="div" size="label" weight="label" tone="muted">{label}</Text>
      <div>{children}</div>
    </div>
  )
}

export function KeymapHintRow({ what, children }: { what: string; children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="small" tone="secondary" className="flex items-baseline justify-between gap-[var(--space-2)]">
      <span>{what}</span>
      <span className="flex gap-[var(--space-1)]">{children}</span>
    </Text>
  )
}

export function KeyCap({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="kbd" size="small" tone="primary" mono className="bg-background border border-border rounded-[var(--tr-radius-input)] px-[var(--space-1)]">
      {children}
    </Text>
  )
}

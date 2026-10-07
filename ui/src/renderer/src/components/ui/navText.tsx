import type { CSSProperties, ReactNode } from 'react'
import { Text } from './Text'

/** A centred one-line note that stands in for a missing body. */
export function CenteredEmptyNote({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="p" size="small" weight="small" tone="secondary" center className="py-[var(--space-5)]">
      {children}
    </Text>
  )
}

/** A bordered sheet that holds rendered report content. */
export function ReportFrame({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return (
    <div data-testid={testId} className="rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-report-frame-inset)]">
      {children}
    </div>
  )
}

/** A wrapping row of related controls. */
export function InlineCluster({ gap = 'md', children }: { gap?: 'sm' | 'md'; children: ReactNode }): React.JSX.Element {
  return (
    <div className={`flex flex-wrap items-center ${gap === 'sm' ? 'gap-[var(--space-1-5)]' : 'gap-[var(--space-2)]'}`}>{children}</div>
  )
}

/** A coloured status pill; `tone` is any CSS colour, the fill is a tint of it. */
export function StatusChip({ tone, children, ...rest }: { tone: string; children: ReactNode } & Record<`data-${string}`, string | undefined>): React.JSX.Element {
  const style: CSSProperties = { color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }
  return (
    <span
      {...rest}
      className="inline-flex flex-none items-center h-[var(--h-status-chip)] px-[var(--space-status-chip-inline)] rounded-[var(--tr-radius-pill)]"
      style={style}
    >
      <Text size="small" weight="small">{children}</Text>
    </span>
  )
}

/** A bulleted list in small muted type. */
export function BulletList({ children, items }: { children?: ReactNode; items?: string[] }): React.JSX.Element {
  return (
    <Text as="ul" size="small" leading="small" tone="muted" className="m-0 grid list-disc gap-[var(--space-1)] pl-[var(--space-4)]">
      {items ? items.map((item, index) => <li key={index}>{item}</li>) : children}
    </Text>
  )
}

export function BulletListSpecimen(): React.JSX.Element {
  return <BulletList items={['Readiness reasons stay scannable.', 'Acceptance items keep their order.']} />
}

/** A card or section heading. */
export function SectionTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="h2" size="ui" weight="semibold" tone="primary" flush>{children}</Text>
}

/** Two columns from the `sm` breakpoint, one below; the grid of a setup form. */
export function FieldGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 items-start gap-[var(--space-3)] sm:grid-cols-2">{children}</div>
}

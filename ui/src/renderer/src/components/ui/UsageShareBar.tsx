import type { ReactNode } from 'react'
import { UsageSectionHeading } from './UsageSectionHeading'
import { Text } from './Text'
import { formatUsd } from '../../usage'

const SEGMENT_COLORS: Record<string, string> = {
  'cache-read': 'color-mix(in srgb, var(--info) 75%, transparent)',
  'cache-write': 'color-mix(in srgb, var(--info) 40%, transparent)',
  output: 'var(--text-primary)',
  input: 'color-mix(in srgb, var(--text-primary) 35%, transparent)',
  other: 'var(--warn)'
}

export interface UsageShareSegment { id: string; label: string; value: number }
export function usageShareTotal(segments: readonly UsageShareSegment[]): number {
  return segments.reduce((total, segment) => total + segment.value, 0)
}

export function UsageShareBar({ heading, segments, aside, note }: { heading: string; segments: UsageShareSegment[]; aside?: string; note?: ReactNode }): React.JSX.Element {
  const total = usageShareTotal(segments)
  const colorFor = (id: string): string => SEGMENT_COLORS[id] ?? 'var(--text-muted)'
  return <section className="grid gap-[var(--space-3)]" data-testid={`usage-share-${heading.toLowerCase().replaceAll(' ', '-')}`}>
    <UsageSectionHeading aside={aside}>{heading}</UsageSectionHeading>
    <span className="flex h-[var(--space-2-5)] w-full gap-[var(--space-0-5)] overflow-hidden rounded-[var(--tr-radius-input)]" aria-label={`${heading} total ${formatUsd(total)}`}>
      {segments.map((segment) => <span key={segment.id} aria-hidden="true" style={{ width: `${total > 0 ? segment.value / total * 100 : 0}%`, background: colorFor(segment.id) }} />)}
    </span>
    <div className="grid gap-[var(--space-1-5)]">
      {segments.map((segment) => <Text key={segment.id} size="small" className="flex items-center gap-[var(--space-2)]">
        <span aria-hidden="true" className="inline-block size-[var(--space-2)] rounded-[var(--tr-radius-input)]" style={{ background: colorFor(segment.id) }} />
        <Text tone="secondary" className="flex-1">{segment.label}</Text>
        <Text tone="muted" tabular className="w-[48px] text-right">{(total > 0 ? segment.value / total * 100 : 0).toFixed(0)}%</Text>
        <Text tone="primary" tabular className="w-[80px] text-right">{formatUsd(segment.value)}</Text>
      </Text>)}
    </div>
    {note && <Text as="p" flush size="small" tone="muted" leading="small" className="border-t border-[var(--divider)] pt-[var(--space-2)]">{note}</Text>}
  </section>
}

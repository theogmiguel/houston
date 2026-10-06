import { Tooltip } from './Tooltip'
import { UsageSectionHeading } from './UsageSectionHeading'
import { formatUsd } from '../../usage'

const SEGMENT_COLORS = [
  'var(--text-faint)',
  'var(--text-muted)',
  'var(--text-secondary)',
  'var(--text-primary)',
  'var(--warn)'
] as const

export interface UsageShareSegment {
  id: string
  label: string
  value: number
}

export function usageShareTotal(segments: readonly UsageShareSegment[]): number {
  return segments.reduce((total, segment) => total + segment.value, 0)
}

export function UsageShareBar({
  heading,
  segments,
  aside
}: {
  heading: string
  segments: UsageShareSegment[]
  aside?: string
}): React.JSX.Element {
  const total = usageShareTotal(segments)
  return (
    <section className="grid gap-[var(--space-2)]" data-testid={`usage-share-${heading.toLowerCase().replaceAll(' ', '-')}`}>
      <UsageSectionHeading aside={aside}>{heading}</UsageSectionHeading>
      <div className="flex h-[8px] overflow-hidden rounded-full bg-[var(--card-hover)]" aria-label={`${heading} total ${total.toFixed(2)}`}>
        {segments.map((segment, index) => {
          const share = total > 0 ? segment.value / total : 0
          return (
            <Tooltip key={segment.id} label={`${segment.label} · ${formatUsd(segment.value)} · ${(share * 100).toFixed(1)}%`}>
              <span aria-hidden="true" className="h-full" style={{ width: `${share * 100}%`, background: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }} />
            </Tooltip>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
        {segments.map((segment, index) => (
          <span key={segment.id} className="inline-flex items-center gap-[var(--space-1-5)] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">
            <span aria-hidden="true" className="h-[7px] w-[7px]" style={{ background: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }} />
            {segment.label} {formatUsd(segment.value)}
          </span>
        ))}
      </div>
    </section>
  )
}

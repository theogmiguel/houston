import { LaunchPresetOutline } from './LaunchLayoutPreview'

const CARD_BASE = 'w-full text-left border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]'
const CARD_STATE = {
  selected: 'border-[var(--border-active)] bg-[var(--card-hover)]',
  idle: 'border-[var(--border)] bg-[var(--card-bg)] hover:border-[var(--border-hover)] hover:bg-[var(--card-hover)]'
} as const

export interface LaunchPresetCardProps {
  id: string
  name: string
  blurb: string
  count: number
  selected: boolean
  onSelect: () => void
  onPreviewStart: () => void
  onPreviewEnd: () => void
}

export function LaunchPresetCard({ id, name, blurb, count, selected, onSelect, onPreviewStart, onPreviewEnd }: LaunchPresetCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-preset={id}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={onPreviewStart}
      onMouseLeave={onPreviewEnd}
      className={`${CARD_BASE} ${selected ? CARD_STATE.selected : CARD_STATE.idle} flex min-w-0 flex-col gap-[5px] rounded-[var(--tr-radius-md)] px-[9px] pt-[9px] pb-[7px]`}
    >
      <span className="flex w-full items-center leading-[15px]"><LaunchPresetOutline count={count} /></span>
      <span className="flex w-full min-w-0 items-center gap-[var(--space-1)] leading-[15px]">
        <span className="min-w-0 flex-1 whitespace-nowrap [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">{name}</span>
        <span className={`[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tabular-nums ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}>{count}</span>
      </span>
      <span className="whitespace-normal [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">{blurb}</span>
    </button>
  )
}

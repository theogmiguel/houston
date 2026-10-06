import type { ReactNode } from 'react'

const OPTION_CLS =
  'grid grid-cols-[var(--sz-choice-radio-column)_minmax(0,1fr)] gap-[var(--space-2-5)] rounded-[var(--tr-radius-md)] border p-[var(--space-3)] cursor-pointer bg-[var(--card-bg)] hover:border-[var(--border-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'

// Literal class strings: Tailwind only generates classes it can read verbatim.
const INK = {
  accent: {
    card: 'border-[var(--choice-accent-border)]',
    ring: 'border-[var(--accent)]',
    dot: 'bg-[var(--accent)]'
  },
  stop: {
    card: 'border-[var(--choice-stop-border)]',
    ring: 'border-[var(--stop)]',
    dot: 'bg-[var(--stop)]'
  }
} as const

export type ChoiceTone = keyof typeof INK

export interface ChoiceCardProps {
  choice: string
  checked: boolean
  tone: ChoiceTone
  onSelect: () => void
  title: ReactNode
  /** A small uppercase tag after the title, for the recommended option. */
  badge?: string
  desc: string
}

/** A drawn radio: a native one takes its box from the OS theme, never ours. */
export function ChoiceCard({ choice, checked, tone, onSelect, title, badge, desc }: ChoiceCardProps): React.JSX.Element {
  const ink = INK[tone]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-choice={choice}
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      className={`${OPTION_CLS} w-full whitespace-normal text-left ${checked ? ink.card : 'border-[var(--border)]'}`}
    >
      <span
        aria-hidden="true"
        className={`relative top-[var(--space-choice-radio-offset)] grid h-[var(--space-4)] w-[var(--space-4)] place-items-center rounded-full border-[length:var(--border-choice-radio)] ${checked ? ink.ring : 'border-[var(--border-hover)]'}`}
      >
        {checked && <span className={`h-[var(--space-2)] w-[var(--space-2)] rounded-full ${ink.dot}`} />}
      </span>
      <span className="grid min-w-0 gap-[var(--space-release-list-items)]">
        <span className="flex flex-wrap items-center gap-[var(--space-2)] font-semibold text-[var(--text-primary)]">
          {title}
          {badge && (
            <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[var(--tr-text-label-tracking)] text-[var(--accent)]">{badge}</span>
          )}
        </span>
        <span className="text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)]">{desc}</span>
      </span>
    </button>
  )
}

export function ChoiceCardSpecimen(): React.JSX.Element {
  return (
    <div data-testid="choice-card-specimen" role="radiogroup" aria-label="Specimen choices" className="grid gap-[var(--space-2)]">
      <ChoiceCard choice="keep" checked tone="accent" onSelect={() => {}} title="Keep sessions running" badge="Recommended" desc="Agents keep working while Houston restarts." />
      <ChoiceCard choice="stop" checked={false} tone="stop" onSelect={() => {}} title="Stop everything and update" desc="Ends all 2 sessions." />
      <ChoiceCard choice="stop-on" checked tone="stop" onSelect={() => {}} title="Stop everything and update" desc="Ends all 2 sessions." />
    </div>
  )
}

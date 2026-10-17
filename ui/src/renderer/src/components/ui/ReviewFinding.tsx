import { useState, type ReactNode } from 'react'
import { IconChevronRight } from '../icons'
import { Card } from './Card'
import { Icon } from './Icon'
import { StatusLabel } from './StatusLabel'
import { Text } from './Text'
import { Button } from './Button'

/** Findings sit in one container-queried card, so rows reflow with the panel, not the window. */
export function ReviewFindingList({ label, children }: { label?: string; children: ReactNode }): React.JSX.Element {
  return <Card shape="card" layout="fields" role="list" aria-label={label}>{children}</Card>
}

export interface ReviewFindingProps {
  heading: string
  meta: ReactNode
  status?: ReactNode
  /** The affirmative action; it and the quiet action each hold a fixed slot so they align across rows. */
  primaryAction?: ReactNode
  secondaryAction?: ReactNode
  detail?: ReactNode
  defaultOpen?: boolean
}

/** One finding: a one-line title that expands its detail, a status column and its actions. */
export function ReviewFinding({ heading, meta, status, primaryAction, secondaryAction, detail, defaultOpen = false }: ReviewFindingProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div role="listitem" data-review-finding className="min-w-0 [&+&]:border-t [&+&]:border-[var(--divider)]">
      <div className="grid min-w-0 items-center gap-x-[var(--space-3)] gap-y-[var(--space-1-5)] px-[var(--space-3)] py-[var(--space-2)] hover:bg-[var(--hover-fill)] [@container_(min-width:600px)]:grid-cols-[minmax(0,1fr)_var(--w-finding-status)_var(--w-finding-action)_var(--w-finding-action)]">
        <div className="grid min-w-0 gap-[var(--space-0-5)]">
          {detail ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-w-0 cursor-pointer items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent p-0 text-left">
              <span aria-hidden="true" className={`flex w-[var(--space-4)] flex-none justify-center text-[var(--text-muted)] ${open ? 'rotate-90' : ''}`}><Icon glyph={IconChevronRight} role="small" /></span>
              <Text size="ui" weight="semibold" tone="primary" className="min-w-0 truncate">{heading}</Text>
            </button>
          ) : (
            <span className="flex min-w-0 items-center gap-[var(--space-2)]">
              <span aria-hidden="true" className="w-[var(--space-4)] flex-none" />
              <Text size="ui" weight="semibold" tone="primary" className="min-w-0 truncate">{heading}</Text>
            </span>
          )}
          <Text as="div" size="small" leading="small" tone="muted" className="min-w-0 pl-[var(--space-5)]">{meta}</Text>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-1-5)] pl-[var(--space-5)] [@container_(min-width:600px)]:contents">
          <div className="min-w-0 flex-1">{status}</div>
          <div className="grid min-w-0 [&>*]:w-full">{primaryAction}</div>
          <div className="grid min-w-0 [&>*]:w-full">{secondaryAction}</div>
        </div>
      </div>
      {detail && open && <div className="px-[var(--space-3)] pb-[var(--space-3)]"><div className="pl-[var(--space-5)]">{detail}</div></div>}
    </div>
  )
}

export interface ReviewFindingFact {
  label: string
  value: ReactNode
  mono?: boolean
}

/** Labelled facts under an expanded finding; values wrap rather than truncate. */
export function ReviewFindingFacts({ facts }: { facts: ReviewFindingFact[] }): React.JSX.Element {
  return (
    <dl className="m-0 grid min-w-0 gap-x-[var(--space-4)] gap-y-[var(--space-2)] [@container_(min-width:600px)]:grid-cols-[max-content_minmax(0,1fr)]">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <Text as="dt" size="small" tone="muted">{fact.label}</Text>
          <Text as="dd" size="small" leading="small" tone="secondary" mono={fact.mono} breakAll={fact.mono} className="m-0 min-w-0">{fact.value}</Text>
        </div>
      ))}
    </dl>
  )
}

/** What became of each finding in one review, under the same status dots the findings use. */
export function ReviewOutcomeList({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return <ul aria-label={label} className="m-0 grid min-w-0 list-none gap-[var(--space-1-5)] p-0">{children}</ul>
}

export function ReviewOutcome({ status, heading, meta }: { status: ReactNode; heading: ReactNode; meta?: ReactNode }): React.JSX.Element {
  return (
    <li className="grid min-w-0 grid-cols-[var(--w-finding-status)_minmax(0,1fr)] items-baseline gap-x-[var(--space-3)]">
      <span className="min-w-0">{status}</span>
      <span className="flex min-w-0 items-baseline gap-x-[var(--space-2)]">
        <Text size="ui" tone="primary" className="min-w-0 truncate">{heading}</Text>
        {meta && <Text size="small" tone="muted" className="flex-none whitespace-nowrap">{meta}</Text>}
      </span>
    </li>
  )
}

/** A file path inside a finding's meta line. */
export function ReviewFindingPath({ children }: { children: string }): React.JSX.Element {
  return <Text mono>{children}</Text>
}

/** Facts joined by middle dots; a long path truncates at its cap and the rest wraps whole. */
export function ReviewFindingMeta({ parts }: { parts: ReactNode[] }): React.JSX.Element {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '')
  return <span className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--space-1)]">{shown.map((part, index) => (
    <span key={index} className={`min-w-0 truncate whitespace-nowrap ${index === 0 ? 'max-w-[min(100%,var(--w-finding-path))]' : 'max-w-full'}`}>{index > 0 && <span aria-hidden="true">·{' '}</span>}{part}</span>
  ))}</span>
}

/** A short excerpt quoted as evidence. */
export function ReviewFindingQuote({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="blockquote" size="small" leading="small" tone="secondary" className="m-0 border-l-2 border-[var(--divider)] pl-[var(--space-2)]">{children}</Text>
}

export function ReviewFindingSpecimen(): React.JSX.Element {
  const noop = (): void => {}
  return (
    <ReviewFindingList label="Findings">
      <ReviewFinding
        heading="Agents re-read the styleguide on every UI change"
        meta="AGENTS.md · 12 of 38 sessions · High confidence"
        status={<StatusLabel status="Open" size="small">New</StatusLabel>}
        primaryAction={<Button variant="secondary" onClick={noop}>Create task</Button>}
        secondaryAction={<Button variant="ghost" onClick={noop}>Dismiss</Button>}
        defaultOpen
        detail={<ReviewFindingFacts facts={[
          { label: 'Recommendation', value: 'Link the token table from AGENTS.md.' },
          { label: 'Target', value: '.claude/rules/renderer/components/navigation/settings-and-review-surfaces.md', mono: true },
          { label: 'Evidence', value: <ReviewFindingQuote>Let me re-read the style guide before editing.</ReviewFindingQuote> }
        ]} />}
      />
      <ReviewFinding heading="Agents run bun test instead of bun run test" meta="AGENTS.md · 11 of 38 sessions" status={<StatusLabel status="Fixing" size="small" />} secondaryAction={<Button variant="ghost" onClick={noop}>Open task</Button>} />
      <ReviewFinding heading="Review #13" meta="Mon 09:00 · 38 sessions · 1 new · 1 gone" secondaryAction={<Button variant="ghost" onClick={noop}>Full report</Button>} defaultOpen detail={<ReviewOutcomeList label="Review #13 findings">
        <ReviewOutcome status={<StatusLabel status="Open" size="small">New</StatusLabel>} heading="Agents re-read the styleguide on every UI change" meta="12 sessions" />
        <ReviewOutcome status={<StatusLabel status="Verified" size="small">Gone</StatusLabel>} heading="Pane titles get truncated" meta="9 sessions since it merged" />
      </ReviewOutcomeList>} />
    </ReviewFindingList>
  )
}

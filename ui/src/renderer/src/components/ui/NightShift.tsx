import type { ReactNode } from 'react'
import { SectionHead } from './SectionHead'
import { Text } from './Text'

export type GateState = 'none' | 'pending' | 'passed' | 'failed'

const GATE_WORD: Record<GateState, string> = { none: 'not run', pending: 'pending', passed: 'passed', failed: 'failed' }

// Facts (checks, CI) are solid; agents' verdicts (review, QA) are outlined.
const FACT_CLS: Record<GateState, string> = {
  none: 'bg-[var(--surface)] text-[var(--text-muted)] border-[var(--border)]',
  pending: 'bg-[var(--status-doing-bg)] text-[var(--status-doing-text)] border-transparent',
  passed: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)] border-transparent',
  failed: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] border-transparent'
}
const VERDICT_CLS: Record<GateState, string> = {
  none: 'bg-transparent text-[var(--text-muted)] border-[var(--border)] border-dashed',
  pending: 'bg-transparent text-[var(--status-doing-text)] border-[var(--status-doing-text)]',
  passed: 'bg-transparent text-[var(--status-done-text)] border-[var(--status-done-text)]',
  failed: 'bg-transparent text-[var(--status-blocked-text)] border-[var(--status-blocked-text)]'
}

/** One gate of a change: `fact` for what Houston or CI observed, `verdict` for an agent's judgement. */
export function GateChip({ label, state, kind }: { label: string; state: GateState; kind: 'fact' | 'verdict' }): React.JSX.Element {
  const paint = kind === 'fact' ? FACT_CLS[state] : VERDICT_CLS[state]
  const text = `${label} ${GATE_WORD[state]}`
  return (
    <span
      data-testid="gate-chip"
      data-gate-kind={kind}
      data-gate-state={state}
      role="img"
      aria-label={`${text}${kind === 'verdict' ? ' (agent verdict)' : ' (fact)'}`}
      className={`inline-flex items-center h-[var(--h-pill)] px-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] border text-[length:var(--tr-text-label-size)] font-medium whitespace-nowrap ${paint}`}
    >
      {text}
    </span>
  )
}

export type WindowMarkKind = 'start' | 'wrap-up' | 'hard-stop' | 'interruption'

export interface WindowMark {
  /** Position along the window, 0 at the start and 1 at the hard stop. */
  at: number
  label: string
  kind: WindowMarkKind
}

const MARK_CLS: Record<WindowMarkKind, string> = {
  start: 'bg-[var(--text-muted)]',
  'wrap-up': 'bg-[var(--text-secondary)]',
  'hard-stop': 'bg-[var(--text-primary)]',
  interruption: 'bg-[var(--status-blocked-text)]'
}

const pct = (at: number): string => `${Math.min(1, Math.max(0, at)) * 100}%`

/** A label grows away from the nearer edge, so it never runs past the strip. */
const align = (at: number): string => (at <= 0.25 ? '' : at >= 0.75 ? '-translate-x-full' : '-translate-x-1/2')

function MarkLabels({ marks, row }: { marks: WindowMark[]; row: string }): React.JSX.Element {
  return (
    <div data-testid={`window-labels-${row}`} className="relative h-[var(--tr-text-label-leading)]">
      {marks.map((m, i) => (
        <span key={`${m.kind}-label-${i}`} className={`absolute whitespace-nowrap ${align(m.at)}`} style={{ left: pct(m.at) }}>
          {m.label}
        </span>
      ))}
    </div>
  )
}

/** The run window as a strip: start, wrap-up and hard stop, how far a live run is, and its interruptions. */
export function NightWindowStrip({ marks, progress, label }: { marks: WindowMark[]; progress?: number; label: string }): React.JSX.Element {
  // The start and hard stop sit at the ends; the wrap-up gets its own row, since
  // it is often close to the hard stop.
  const edges = marks.filter((m) => m.kind === 'start' || m.kind === 'hard-stop')
  const inner = marks.filter((m) => m.kind === 'wrap-up')
  return (
    <div role="group" aria-label={label} className="grid gap-[var(--space-1)]">
      <div className="relative h-[var(--space-1-5)] rounded-[var(--tr-radius-pill)] bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
        {progress !== undefined && (
          <div data-testid="window-progress" className="absolute inset-y-0 left-0 bg-[var(--selected-fill)]" style={{ width: pct(progress) }} />
        )}
        {marks.map((m, i) => (
          <span
            key={`${m.kind}-${i}`}
            data-testid={`window-mark-${m.kind}`}
            role="img"
            aria-label={m.kind === 'interruption' ? `Interruption: ${m.label}` : m.label}
            className={`absolute inset-y-0 w-[var(--space-0-5)] ${MARK_CLS[m.kind]}`}
            style={{ left: `calc(${pct(m.at)} - var(--space-pixel))` }}
          />
        ))}
      </div>
      <div className="grid text-[length:var(--tr-text-label-size)] text-[var(--text-muted)] tabular-nums">
        <MarkLabels marks={edges} row="edges" />
        {inner.length > 0 && <MarkLabels marks={inner} row="inner" />}
      </div>
    </div>
  )
}

/** One column of a run's plan board. */
export function NightPlanColumn({ heading, count, children, empty }: { heading: string; count: number; children: ReactNode; empty: string }): React.JSX.Element {
  return (
    <section aria-label={heading} className="grid content-start gap-[var(--space-1-5)] min-w-0 p-[var(--space-2)] rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)]">
      <SectionHead title={heading} count={count} variant="label" tone="faint" />
      {count === 0 ? <Text size="small" tone="muted">{empty}</Text> : <ul className="grid gap-[var(--space-1)] m-0 p-0 list-none">{children}</ul>}
    </section>
  )
}

/** The plan board: one column on narrow panes, three side by side otherwise. */
export function NightPlanBoard({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 md:grid-cols-3 gap-[var(--space-2)]">{children}</div>
}

/** One item of a plan column. */
export function NightPlanItem({ label, meta }: { label: string; meta?: ReactNode }): React.JSX.Element {
  return (
    <li className="grid gap-[var(--space-0-5)] min-w-0 px-[var(--space-2)] py-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[var(--surface)]">
      <Text size="small" className="truncate">{label}</Text>
      {meta && <Text size="small" tone="muted">{meta}</Text>}
    </li>
  )
}

export function NightShiftSpecimen(): React.JSX.Element {
  const states: GateState[] = ['none', 'pending', 'passed', 'failed']
  return (
    <div className="grid gap-[var(--space-3)]" data-testid="night-shift-specimen">
      <div className="flex flex-wrap gap-[var(--space-1)]">
        {states.map((s) => <GateChip key={`f-${s}`} label="Checks" state={s} kind="fact" />)}
        {states.map((s) => <GateChip key={`v-${s}`} label="Review" state={s} kind="verdict" />)}
      </div>
      <NightWindowStrip
        label="Window 23:30 to 07:30"
        marks={[
          { at: 0, label: '23:30', kind: 'start' },
          { at: 0.906, label: 'Wrap-up 06:45', kind: 'wrap-up' },
          { at: 1, label: '07:30', kind: 'hard-stop' }
        ]}
      />
      <NightWindowStrip
        label="Live run"
        progress={0.42}
        marks={[
          { at: 0, label: '23:30', kind: 'start' },
          { at: 0.31, label: 'Daemon restart', kind: 'interruption' },
          { at: 0.906, label: 'Wrap-up', kind: 'wrap-up' },
          { at: 1, label: '07:30', kind: 'hard-stop' }
        ]}
      />
      <NightPlanBoard>
        <NightPlanColumn heading="Planned" count={1} empty="Nothing planned"><NightPlanItem label="Faster attach" meta="performance" /></NightPlanColumn>
        <NightPlanColumn heading="Pull requests" count={0} empty="No PRs yet">{null}</NightPlanColumn>
        <NightPlanColumn heading="Deferred" count={1} empty="Nothing deferred"><NightPlanItem label="Rewrite the tray" /></NightPlanColumn>
      </NightPlanBoard>
    </div>
  )
}

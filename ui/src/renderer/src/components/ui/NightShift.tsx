import { useId, type ReactNode } from 'react'
import { IconInfo } from '../icons'
import { Icon } from './Icon'
import { RadioCard } from './RadioCard'
import { SectionHead } from './SectionHead'
import { Text } from './Text'
import { TextInput } from './TextInput'
import { Tooltip } from './Tooltip'

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

/** A field's explanation: an info button whose tooltip opens on hover, keyboard focus or a
 * click. The text is self-sufficient; the field itself carries no hint line. */
export function InfoTip({ about, children }: { about: string; children: string }): React.JSX.Element {
  return (
    <Tooltip label={children} openOnClick inline>
      <button type="button" aria-label={`About ${about}`} className="btn inline-flex items-center justify-center flex-none p-[var(--space-0-5)] rounded-full border-0 bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        <Icon glyph={IconInfo} role="small" />
      </button>
    </Tooltip>
  )
}

export type NightBadgeTone = 'required' | 'answered'

const BADGE_CLS: Record<NightBadgeTone, string> = {
  required: 'text-[var(--status-doing-text)] border-[var(--status-doing-text)]',
  answered: 'text-[var(--status-done-text)] border-[var(--status-done-text)]'
}

/** A Setup question: its number, heading, an optional Required/Answered badge, and its body. */
export function NightQuestion({ number, heading, badge, children }: {
  number: number
  heading: string
  badge?: { label: string; tone: NightBadgeTone }
  children: ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className="grid gap-[var(--space-3)] p-[var(--space-4)] rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)]">
      <div className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
        <Text weight="semibold" tone="muted" tabular>{number}</Text>
        <h2 id={id} className="m-0 [font-size:var(--tr-text-subhead-size)] font-semibold">{heading}</h2>
        {badge && <span data-testid="night-question-badge" data-tone={badge.tone} className={`inline-flex items-center h-[var(--h-pill)] px-[var(--space-1-5)] rounded-[var(--tr-radius-pill)] border text-[length:var(--tr-text-label-size)] whitespace-nowrap ${BADGE_CLS[badge.tone]}`}>{badge.label}</span>}
      </div>
      {children}
    </section>
  )
}

/** One step of how a change is judged: a numbered row (dashed when optional), its heading
 * and tooltip, what sits beside it on the same line, and anything it reveals below. */
export function NightStep({ number, heading, tip, optional = false, aside, children }: {
  number: number
  heading: string
  tip: string
  optional?: boolean
  aside?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div role="group" aria-label={heading} className="grid gap-[var(--space-2)] py-[var(--space-3)] border-t border-t-[var(--divider)]">
      <div className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
        <div className="flex flex-1 basis-[var(--tr-control-width-wide)] min-w-0 items-center gap-[var(--space-2)]">
          <span data-testid="night-step-number" data-optional={optional} className={`inline-flex flex-none items-center justify-center w-[var(--h-pill)] h-[var(--h-pill)] rounded-full border text-[length:var(--tr-text-label-size)] text-[var(--text-secondary)] ${optional ? 'border-dashed border-[var(--border-hover)]' : 'border-[var(--border)]'}`}>{number}</span>
          <Text weight="semibold">{heading}</Text>
          <InfoTip about={heading}>{tip}</InfoTip>
        </div>
        {aside}
      </div>
      {children && <div className="grid gap-[var(--space-2)] ps-[var(--space-6)]">{children}</div>}
    </div>
  )
}

type Labelled = { role?: 'group'; 'aria-label'?: string }

/** One item of a Setup list in its own box: a check, a competitor, the merge queue's options. */
export function NightBox({ children, ...aria }: Labelled & { children: ReactNode }): React.JSX.Element {
  return <div {...aria} className="grid gap-[var(--space-1)] p-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border)]">{children}</div>
}

/** A control that takes the rest of its row and wraps below the given width. */
export function NightGrow({ children, basis = 'wide' }: { children: ReactNode; basis?: 'wide' | 'medium' }): React.JSX.Element {
  return <div className={`flex-1 min-w-0 ${basis === 'wide' ? 'basis-[var(--tr-control-width-wide)]' : 'basis-[var(--tr-control-width-medium)]'}`}>{children}</div>
}

/** What a switch or a choice reveals, indented under it. */
export function NightReveal({ children, ...aria }: Labelled & { children: ReactNode }): React.JSX.Element {
  return <div {...aria} className="grid gap-[var(--space-2)] ps-[var(--space-6)]">{children}</div>
}

/** One row of a divided list, such as a focus area. */
export function NightDividedRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)] py-[var(--space-2)] border-t border-t-[var(--divider)]">{children}</div>
}

/** The Setup's heading and its one-line purpose. */
export function NightSetupHeader({ heading, description }: { heading: string; description: string }): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-1)]">
      <h1 className="m-0 [font-size:var(--tr-text-heading-size)] font-semibold">{heading}</h1>
      <Text tone="secondary">{description}</Text>
    </div>
  )
}

/** The Setup's footer bar: readiness, save state and the actions. */
export function NightSetupFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--tr-radius-card)] border border-[var(--border)]">{children}</div>
}

/** Choice cards side by side, wrapping on a narrow pane. */
export function NightChoiceGrid({ children, 'aria-label': label }: { children: ReactNode; 'aria-label': string }): React.JSX.Element {
  return <div role="radiogroup" aria-label={label} className="grid grid-cols-[repeat(auto-fit,minmax(var(--tr-control-width-wide),1fr))] gap-[var(--space-2)]">{children}</div>
}

/** One choice card: its name and what choosing it means. */
export function NightChoice({ selected, heading, description, onSelect }: { selected: boolean; heading: string; description: string; onSelect: () => void }): React.JSX.Element {
  return (
    <RadioCard selected={selected} onClick={onSelect}>
      <span className="grid w-full gap-[var(--space-0-5)] p-[var(--space-3)]">
        <Text weight="semibold">{heading}</Text>
        <Text size="small" tone="secondary">{description}</Text>
      </span>
    </RadioCard>
  )
}

/** A named field with its explanation, for a field grid. */
export function NightField({ label, tip, children }: { label: string; tip: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="grid content-start gap-[var(--space-1)] min-w-0">
      <div className="flex items-center gap-[var(--space-1)]"><Text weight="semibold">{label}</Text><InfoTip about={label}>{tip}</InfoTip></div>
      {children}
    </div>
  )
}

/** Fields in one grid: two columns where they fit, one on a narrow pane. */
export function NightFieldGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,var(--tr-control-width-wide)),1fr))] gap-x-[var(--space-5)] gap-y-[var(--space-4)] items-start p-[var(--space-3)]">{children}</div>
}

/** A disclosure's body, inset from its edges. */
export function NightDisclosureBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-3)] px-[var(--space-3)] pb-[var(--space-3)]">{children}</div>
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
      <NightSetupHeader heading="Set up Night shift" description="Choose what it should work on and press Run now." />
      <NightQuestion number={1} heading="What should it work on?" badge={{ label: 'Required', tone: 'required' }}>
        <NightDividedRow><NightGrow basis="medium"><Text weight="semibold">Reliability</Text></NightGrow></NightDividedRow>
        <NightReveal><NightBox><Text size="small">github.com/owner/repo</Text></NightBox></NightReveal>
        <NightStep number={1} heading="Claims and proofs" tip="Each change lists what must be true and the test that proves it." aside={<Text size="small" tone="muted">Fixed, nothing to set</Text>} />
        <NightStep number={5} optional heading="App QA" tip="A QA pane drives the app for changes you can see." aside={<Text size="small" tone="muted">Off</Text>}>
          <TextInput aria-label="What to open" size="form" width="full" placeholderTone="faint" placeholder="Per change: the story or screen it touches" />
        </NightStep>
      </NightQuestion>
      <NightQuestion number={2} heading="How do I know a change is good?" badge={{ label: 'Answered from the repository', tone: 'answered' }}>
        <NightChoiceGrid aria-label="Output">
          <NightChoice selected heading="Draft pull requests" description="You review and merge them yourself." onSelect={() => {}} />
          <NightChoice selected={false} heading="Merge queue" description="Ready pull requests join the merge queue." onSelect={() => {}} />
        </NightChoiceGrid>
        <NightDisclosureBody><NightFieldGrid><NightField label="Reviewer" tip="Reads every change.">{null}</NightField></NightFieldGrid></NightDisclosureBody>
      </NightQuestion>
      <NightSetupFooter><Text tone="ok">Ready to run.</Text></NightSetupFooter>
    </div>
  )
}

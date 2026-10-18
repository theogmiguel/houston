import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { IconCheck, IconClose } from '../icons'
import { MonoBlock } from './MonoBlock'
import { StatusLabel, type StatusLabelValue } from './StatusLabel'
import { Text } from './Text'

/** A queue row's title: its rank in faint tabular figures, the number, then the title. */
export function MergeQueueRowTitle({ rank, number, heading }: { rank: number | null; number: number; heading: ReactNode }): React.JSX.Element {
  return <span className="flex min-w-0 items-baseline gap-[var(--space-2)]">
    {rank !== null && <span className="w-[var(--space-3)] flex-none text-right tabular-nums text-[var(--text-faint)]">{rank}</span>}
    <span className="flex-none font-mono text-[var(--text-muted)]">#{number}</span>
    <span className="min-w-0 truncate">{heading}</span>
  </span>
}

/** Where a pull request stands in the queue, as the merge box footer says it. */
export function MergeQueueStanding({ status, children }: { status: StatusLabelValue; children: ReactNode }): React.JSX.Element {
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-[var(--space-1-5)]"><StatusLabel status={status} size="small" /><span>{children}</span></span>
}

export type MergeQueueGateTone = 'passed' | 'failed' | 'not_applicable' | 'pending'

export interface MergeQueueGateItem {
  label: string
  state: MergeQueueGateTone
  reason?: string | null
}

function GateMark({ state }: { state: MergeQueueGateTone }): React.JSX.Element {
  if (state === 'passed') return <span aria-hidden="true" className="flex flex-none text-[var(--ok)]"><Icon glyph={IconCheck} role="small" /></span>
  if (state === 'failed') return <span aria-hidden="true" className="flex flex-none text-[var(--stop)]"><Icon glyph={IconClose} role="small" /></span>
  if (state === 'pending') return <span aria-hidden="true" className="flex w-[var(--space-3)] flex-none justify-center text-[var(--text-faint)]">·</span>
  return <span aria-hidden="true" className="flex w-[var(--space-3)] flex-none justify-center text-[var(--text-faint)]">–</span>
}

const GATE_STATE_NAME: Record<MergeQueueGateTone, string> = { passed: 'passed', failed: 'failed', not_applicable: 'does not apply', pending: 'not run yet' }

/** The gates of one entry as a checklist: a mark, the gate, and why it failed. */
export function MergeQueueGates({ gates }: { gates: readonly MergeQueueGateItem[] }): React.JSX.Element {
  return <ul aria-label="Gates" className="m-0 grid list-none gap-[var(--space-2)] p-0">
    {gates.map((gate) => <li key={gate.label} aria-label={`${gate.label}: ${GATE_STATE_NAME[gate.state]}`} className="flex min-w-0 items-start gap-[var(--space-2)]">
      <GateMark state={gate.state} />
      <span className="grid min-w-0 gap-[var(--space-0-5)]">
        <Text size="ui" tone={gate.state === 'not_applicable' || gate.state === 'pending' ? 'muted' : 'primary'}>{gate.label}</Text>
        {gate.reason && <Text size="small" tone="muted">{gate.reason}</Text>}
      </span>
    </li>)}
  </ul>
}

/** The selected entry: what it is, its one status, its gates and one primary action. */
export function MergeQueueDetail({ heading, meta, status, notice, gates, actions }: { heading: ReactNode; meta: ReactNode; status: StatusLabelValue; notice?: ReactNode; gates?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <section className="grid min-w-0 content-start gap-[var(--space-4)]">
    <header className="grid min-w-0 gap-[var(--space-1)]">
      <StatusLabel status={status} size="small" />
      <Text as="h3" size="subhead" weight="subhead" tone="primary" className="min-w-0">{heading}</Text>
      <Text size="small" tone="muted" className="min-w-0 truncate">{meta}</Text>
    </header>
    {notice}
    {gates && <div className="grid gap-[var(--space-2)]"><Text size="label" weight="label" tone="faint">Gates</Text>{gates}</div>}
    {actions && <div className="flex flex-wrap items-center gap-[var(--space-2)]">{actions}</div>}
  </section>
}

/** Why an entry left the line: the reason, then the conflicting files or the
 *  tail of the command's output, never a count parsed from it. */
export function MergeQueueFailure({ reason, files, output }: { reason: ReactNode; files?: readonly string[]; output?: string | null }): React.JSX.Element {
  return <div className="grid min-w-0 gap-[var(--space-3)]" data-testid="merge-queue-failure">
    <Text size="ui" tone="secondary">{reason}</Text>
    {files && files.length > 0 && <div className="grid gap-[var(--space-1)]">
      <Text size="label" weight="label" tone="faint">Conflicting files</Text>
      <ul aria-label="Conflicting files" className="m-0 grid list-none gap-[var(--space-1)] p-0">
        {files.map((file) => <li key={file} className="min-w-0 truncate"><Text size="small" tone="primary" mono>{file}</Text></li>)}
      </ul>
    </div>}
    {output && <div className="grid gap-[var(--space-1)]">
      <Text size="label" weight="label" tone="faint">Last lines of the output</Text>
      <MonoBlock variant="reason" aria-label="Last lines of the output">{output}</MonoBlock>
    </div>}
  </div>
}

/** What the queue does on its own, above the list, with the queue's own actions. */
export function MergeQueuePolicy({ children, actions }: { children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-2)]" data-testid="merge-queue-policy">
    <Text size="small" tone="muted" className="min-w-0 flex-1 truncate">{children}</Text>
    {actions && <span className="flex flex-none items-center gap-[var(--space-1)]">{actions}</span>}
  </div>
}

export function MergeQueueSpecimen(): React.JSX.Element {
  return <div className="grid max-w-[520px] gap-[var(--space-4)]">
    <div className="grid gap-[var(--space-1)]">
      <Text size="ui" tone="primary"><MergeQueueRowTitle rank={1} number={212} heading="Add a preferences table and service" /></Text>
      <Text size="ui" tone="primary"><MergeQueueRowTitle rank={2} number={215} heading="Rename utils/date to utils/time" /></Text>
      <MergeQueueStanding status="Ready">1st in merge queue · merges 0123456 exactly, by squash</MergeQueueStanding>
    </div>
    <MergeQueueDetail
      heading="#215 Rename utils/date to utils/time"
      meta="houston/rename-date · 2nd in line"
      status="Blocked"
      gates={<MergeQueueGates gates={[
        { label: 'Mergeable', state: 'passed' },
        { label: 'No unresolved review threads', state: 'failed', reason: 'PR #215 has 1 unresolved review thread' },
        { label: 'Reviewer passed', state: 'not_applicable', reason: 'Not a task Slice' },
        { label: 'Verification', state: 'pending', reason: 'Runs when it is first in line' }
      ]} />}
    />
    <MergeQueuePolicy>Merges when verified · cargo nextest run --workspace · one at a time on this machine</MergeQueuePolicy>
    <MergeQueueDetail
      heading="#209 Show preferences in Settings"
      meta="houston/settings-prefs · out of line"
      status="Parked"
      notice={<MergeQueueFailure reason="Rebasing onto main@7f03d1 stopped on a conflict in 2 files" files={['src/settings/Preferences.tsx', 'src/lib/loadPreferences.ts']} />}
    />
    <MergeQueueFailure reason="`cargo test` failed (exit 101) on the head rebased onto main@a91c2e" output={'test export::csv_rows ... FAILED\nfailures:\n    export::csv_rows'} />
  </div>
}

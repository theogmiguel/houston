import { useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessFindingPhase } from '../../houston/generated/HarnessFindingPhase'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import { openSideTasks } from '../../sidePanel'
import { Button, Caption, Card, SectionHead, Segmented, StatusLabel, type StatusLabelValue } from '../ui'
import { SettingsToolbar } from '../ui/SettingsToolbar'
import { SectionTitle } from '../ui/navText'
import { ReviewFinding, ReviewFindingFacts, ReviewFindingList, ReviewFindingMeta, ReviewFindingPath, ReviewFindingQuote, type ReviewFindingFact } from '../ui/ReviewFinding'
import { formatHarnessDate } from './harnessFormat'

export type HarnessFilter = 'active' | 'resolved' | 'dismissed'
export type HarnessFindingAction = 'create_task' | 'dismiss' | 'open_task' | 'verify_now' | 'resolve' | 'keep_open' | 'reopen'

export function phaseActions(phase: HarnessFindingPhase): HarnessFindingAction[] {
  if (phase === 'open') return ['create_task', 'dismiss']
  if (phase === 'fixing') return ['open_task']
  if (phase === 'awaiting_verification') return ['verify_now']
  if (phase === 'not_seen') return ['resolve', 'keep_open']
  return ['reopen']
}

export function phaseStatus(phase: HarnessFindingPhase): StatusLabelValue {
  if (phase === 'open') return 'Open'
  if (phase === 'not_seen') return 'Not seen'
  if (phase === 'fixing' || phase === 'awaiting_verification') return 'Fixing'
  return phase === 'resolved' ? 'Done' : 'Paused'
}

/** The word each phase shows beside its status dot; the dot keeps the status vocabulary. */
const PHASE_WORD: Record<HarnessFindingPhase, string> = {
  open: 'New',
  fixing: 'Fixing',
  awaiting_verification: 'Checking fix',
  not_seen: 'Not seen',
  resolved: 'Resolved',
  dismissed: 'Dismissed'
}

/** Actions that move a finding forward take the bordered slot; the rest stay quiet text buttons. */
const PRIMARY_ACTIONS: HarnessFindingAction[] = ['create_task', 'verify_now', 'resolve']

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

/** Highest confidence first, then the most sessions; ties keep the review's own order. */
export function sortFindings(findings: HarnessFinding[]): HarnessFinding[] {
  const rank = (f: HarnessFinding): number => CONFIDENCE_RANK[f.confidence.toLowerCase()] ?? 3
  return [...findings].sort((a, b) => rank(a) - rank(b) || b.count - a.count)
}

const DECIDE: HarnessFindingPhase[] = ['open', 'not_seen']
const IN_PROGRESS: HarnessFindingPhase[] = ['fixing', 'awaiting_verification']

export function findingGroups(findings: HarnessFinding[], filter: HarnessFilter): { label: string | null; findings: HarnessFinding[] }[] {
  if (filter !== 'active') return [{ label: null, findings: findings.filter((f) => f.phase === filter) }]
  return [
    { label: 'Needs a decision', findings: sortFindings(findings.filter((f) => DECIDE.includes(f.phase))) },
    { label: 'In progress', findings: sortFindings(findings.filter((f) => IN_PROGRESS.includes(f.phase))) }
  ].filter((group) => group.findings.length > 0)
}

export interface HarnessFindingsProps {
  workspace: string
  findings: HarnessFinding[]
  defaultEngine: AgentKind
  latestReviewId: number | null
  latestReviewSessions: number | null
  onDecide: (key: string, state: HarnessFindingState) => void
  onCreateTask: (key: string, agent: AgentKind, prompt: string) => void
  onVerifyNow: () => void
}

export function HarnessFindings(props: HarnessFindingsProps): React.JSX.Element {
  const { findings, latestReviewId } = props
  const [filter, setFilter] = useState<HarnessFilter>('active')
  const active = findings.filter((f) => DECIDE.includes(f.phase) || IN_PROGRESS.includes(f.phase)).length
  const resolved = findings.filter((f) => f.phase === 'resolved').length
  const dismissed = findings.filter((f) => f.phase === 'dismissed').length
  const groups = findingGroups(findings, filter)

  return (
    <section className="grid gap-[var(--space-3)]" aria-label="Harness findings">
      <SettingsToolbar actions={<Segmented<HarnessFilter>
        aria-label="Finding phase"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: 'Active', count: active || undefined, testId: 'harness-filter-active' },
          { value: 'resolved', label: 'Resolved', count: resolved || undefined, testId: 'harness-filter-resolved' },
          { value: 'dismissed', label: 'Dismissed', count: dismissed || undefined, testId: 'harness-filter-dismissed' }
        ]}
      />}><SectionTitle>Findings</SectionTitle></SettingsToolbar>
      {groups.some((group) => group.findings.length > 0) ? groups.map((group) => (
        <div key={group.label ?? filter} className="grid gap-[var(--space-1-5)]">
          {group.label && <SectionHead title={group.label} count={group.findings.length} />}
          <ReviewFindingList label={group.label ?? `${filter} findings`}>
            {group.findings.map((finding) => <FindingRow key={finding.key} {...props} finding={finding} />)}
          </ReviewFindingList>
        </div>
      )) : (
        <Card shape="card" padding="md"><Caption>{emptyFindingsCopy(filter, latestReviewId)}</Caption></Card>
      )}
    </section>
  )
}

function emptyFindingsCopy(filter: HarnessFilter, latestReviewId: number | null): string {
  if (filter !== 'active') return `No ${filter} findings.`
  return latestReviewId === null ? 'No findings yet. They appear here when the first review publishes.' : 'No active findings.'
}

function confidenceLabel(confidence: string): string | null {
  const value = confidence.trim().toLowerCase()
  return value ? `${value[0].toUpperCase()}${value.slice(1)} confidence` : null
}

function TaskLink({ finding }: { finding: HarnessFinding }): React.JSX.Element | null {
  const task = finding.task
  if (!task) return null
  return <Button variant="body-link" onClick={() => openSideTasks(false, task.task_id)}>{task.key}</Button>
}

/** The one-line facts under a finding's title, chosen by what its phase needs next. */
export function findingMetaParts(f: HarnessFinding, latestReviewId: number | null, latestReviewSessions: number | null): React.ReactNode[] {
  const sessions = latestReviewSessions == null ? `${f.count} sessions` : `${f.count} of ${latestReviewSessions} sessions`
  const path = <ReviewFindingPath>{f.target}</ReviewFindingPath>
  switch (f.phase) {
    case 'open': return [path, sessions, confidenceLabel(f.confidence)]
    case 'fixing': return [<><TaskLink finding={f} /> {f.task?.status.replace('_', ' ')}</>, sessions, 'checked again after it merges']
    case 'awaiting_verification': return [
      <><TaskLink finding={f} /> merged {f.task?.landed_at_ms ? formatHarnessDate(f.task.landed_at_ms) : ''}</>,
      f.verification?.sessions_after == null ? 'Verification pending' : `${f.verification.sessions_after} sessions since`,
      'verdict in the next review'
    ]
    case 'not_seen': return [path, `not raised by review #${latestReviewId ?? f.review_id}`, `last seen in #${f.last_seen_review_id} (${f.count} sessions)`]
    default: return [path, `last seen in review #${f.last_seen_review_id}`]
  }
}

export function findingFacts(f: HarnessFinding): ReviewFindingFact[] {
  const facts: ReviewFindingFact[] = []
  if (f.recommendation) facts.push({ label: 'Recommendation', value: f.recommendation })
  facts.push({ label: 'Target', value: f.target, mono: true })
  const evidence = `${f.count} session${f.count === 1 ? '' : 's'}${f.recurred ? ' · raised again after a decision' : ''}`
  facts.push({ label: 'Evidence', value: <span className="grid gap-[var(--space-1-5)]">{evidence}{f.quotes.map((quote, index) => <ReviewFindingQuote key={index}>{quote}</ReviewFindingQuote>)}</span> })
  if (f.sessions.length) facts.push({ label: 'Sessions', value: f.sessions.join(', '), mono: true })
  facts.push({ label: 'Raised', value: `Review #${f.review_id}${f.category ? ` · ${f.category}` : ''}` })
  return facts
}

function FindingRow({ finding: f, latestReviewId, latestReviewSessions, defaultEngine, onDecide, onCreateTask, onVerifyNow }: HarnessFindingsProps & { finding: HarnessFinding }): React.JSX.Element {
  const actions = phaseActions(f.phase)
  const primary = actions.find((action) => PRIMARY_ACTIONS.includes(action))
  const secondary = actions.find((action) => !PRIMARY_ACTIONS.includes(action))
  return (
    <ReviewFinding
      heading={f.title}
      meta={<ReviewFindingMeta parts={findingMetaParts(f, latestReviewId, latestReviewSessions)} />}
      status={<StatusLabel status={phaseStatus(f.phase)} size="small">{PHASE_WORD[f.phase]}</StatusLabel>}
      primaryAction={primary && <FindingActionButton action={primary} finding={f} engine={defaultEngine} onDecide={onDecide} onCreateTask={onCreateTask} onVerifyNow={onVerifyNow} />}
      secondaryAction={secondary && <FindingActionButton action={secondary} finding={f} engine={defaultEngine} onDecide={onDecide} onCreateTask={onCreateTask} onVerifyNow={onVerifyNow} />}
      detail={<ReviewFindingFacts facts={findingFacts(f)} />}
    />
  )
}

function FindingActionButton({
  action,
  finding,
  engine,
  onDecide,
  onCreateTask,
  onVerifyNow
}: {
  action: HarnessFindingAction
  finding: HarnessFinding
  engine: AgentKind
  onDecide: HarnessFindingsProps['onDecide']
  onCreateTask: HarnessFindingsProps['onCreateTask']
  onVerifyNow: () => void
}): React.JSX.Element {
  switch (action) {
    case 'create_task':
      return <Button variant="secondary" onClick={() => onCreateTask(finding.key, engine, finding.apply_prompt)}>Create task</Button>
    case 'dismiss':
      return <Button variant="ghost" onClick={() => onDecide(finding.key, 'dismissed')}>Dismiss</Button>
    case 'open_task':
      return <Button variant="ghost" onClick={() => finding.task && openSideTasks(false, finding.task.task_id)}>Open task</Button>
    case 'verify_now':
      return <Button variant="secondary" onClick={onVerifyNow}>Verify now</Button>
    case 'resolve':
      return <Button variant="secondary" onClick={() => onDecide(finding.key, 'resolved')}>Resolve</Button>
    case 'keep_open':
      return <Button variant="ghost" onClick={() => onDecide(finding.key, 'open')}>Keep open</Button>
    case 'reopen':
      return <Button variant="ghost" onClick={() => onDecide(finding.key, 'open')}>Reopen</Button>
  }
}

import { useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { HarnessFindingPhase } from '../../houston/generated/HarnessFindingPhase'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import { openSideTasks } from '../../sidePanel'
import { Button, Card, Segmented, StatusLabel, type StatusLabelValue } from '../ui'

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

export function HarnessFindings({
  findings,
  defaultEngine,
  latestReviewId,
  latestReviewSessions,
  onDecide,
  onCreateTask,
  onVerifyNow
}: HarnessFindingsProps): React.JSX.Element {
  const [filter, setFilter] = useState<HarnessFilter>('active')
  const isActive = (f: HarnessFinding): boolean => ['open', 'fixing', 'awaiting_verification', 'not_seen'].includes(f.phase)
  const counts = {
    active: findings.filter(isActive).length,
    resolved: findings.filter((f) => f.phase === 'resolved').length,
    dismissed: findings.filter((f) => f.phase === 'dismissed').length
  }
  const shown = findings.filter((f) => filter === 'active' ? isActive(f) : f.phase === filter)

  return (
    <section className="grid gap-[var(--space-2)]" aria-label="Harness findings">
      <Segmented<HarnessFilter>
        aria-label="Finding phase"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: `Active ${counts.active}`, testId: 'harness-filter-active' },
          { value: 'resolved', label: `Resolved ${counts.resolved}`, testId: 'harness-filter-resolved' },
          { value: 'dismissed', label: `Dismissed ${counts.dismissed}`, testId: 'harness-filter-dismissed' }
        ]}
      />
      {shown.length ? (
        <Card>
          {shown.map((finding) => (
            <FindingRow
              key={finding.key}
              finding={finding}
              latestReviewId={latestReviewId}
              latestReviewSessions={latestReviewSessions}
              defaultEngine={defaultEngine}
              onDecide={onDecide}
              onCreateTask={onCreateTask}
              onVerifyNow={onVerifyNow}
            />
          ))}
        </Card>
      ) : (
        <p>{filter === 'active' ? 'No active findings.' : `No ${filter} findings.`}</p>
      )}
    </section>
  )
}

function FindingRow({
  finding: f,
  latestReviewId,
  latestReviewSessions,
  defaultEngine,
  onDecide,
  onCreateTask,
  onVerifyNow
}: Pick<HarnessFindingsProps, 'latestReviewId' | 'latestReviewSessions' | 'defaultEngine' | 'onDecide' | 'onCreateTask' | 'onVerifyNow'> & { finding: HarnessFinding }): React.JSX.Element {
  const reviewSessions = latestReviewSessions ?? f.count
  const task = f.task
  const linkedTask = task && (
    <Button size="sm" variant="link" onClick={() => openSideTasks(false, task.task_id)}>
      {task.key}
    </Button>
  )
  const meta = f.phase === 'open' ? (
    <>{f.count} of {reviewSessions} sessions · target <code>{f.target}</code> · new in review #{f.review_id}</>
  ) : f.phase === 'fixing' ? (
    <>{f.count} of {reviewSessions} sessions · {linkedTask} {task?.status.replace('_', ' ')} · checked again after it merges</>
  ) : f.phase === 'awaiting_verification' ? (
    <>{linkedTask} merged {task?.landed_at_ms ? new Date(task.landed_at_ms).toLocaleDateString() : ''} · {f.verification?.sessions_after ?? 0} sessions since · verdict in the next review</>
  ) : f.phase === 'not_seen' ? (
    <>No task · not raised by review #{latestReviewId ?? f.review_id} · last seen in #{f.last_seen_review_id} ({f.count} sessions)</>
  ) : (
    <>{f.phase === 'resolved' ? 'Resolved' : 'Dismissed'} · last seen in review #{f.last_seen_review_id}</>
  )
  return (
    <Card.Row
      heading={f.title}
      meta={meta}
      status={<StatusLabel status={phaseStatus(f.phase)} />}
      action={<span className="flex flex-wrap items-center gap-[var(--space-1-5)]">{phaseActions(f.phase).map((action) => (
        <FindingActionButton
          key={action}
          action={action}
          finding={f}
          engine={defaultEngine}
          onDecide={onDecide}
          onCreateTask={onCreateTask}
          onVerifyNow={onVerifyNow}
        />
      ))}</span>}
      className="px-[var(--space-2-5)]"
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
      return <Button size="sm" variant="secondary" onClick={() => onCreateTask(finding.key, engine, finding.apply_prompt)}>Create task</Button>
    case 'dismiss':
      return <Button size="sm" variant="ghost" onClick={() => onDecide(finding.key, 'dismissed')}>Dismiss</Button>
    case 'open_task':
      return <Button size="sm" variant="ghost" onClick={() => finding.task && openSideTasks(false, finding.task.task_id)}>Open task</Button>
    case 'verify_now':
      return <Button size="sm" variant="secondary" onClick={onVerifyNow}>Verify now</Button>
    case 'resolve':
      return <Button size="sm" variant="secondary" onClick={() => onDecide(finding.key, 'resolved')}>Resolve</Button>
    case 'keep_open':
      return <Button size="sm" variant="ghost" onClick={() => onDecide(finding.key, 'open')}>Keep open</Button>
    case 'reopen':
      return <Button size="sm" variant="ghost" onClick={() => onDecide(finding.key, 'open')}>Reopen</Button>
  }
}

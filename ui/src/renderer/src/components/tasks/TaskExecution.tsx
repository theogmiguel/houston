import { useSession } from '../../sessionsStore'
import { useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo } from '../../houston/client'
import type { Task } from '../../houston/generated/Task'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunAction } from '../../houston/generated/TaskRunAction'
import type { TaskStartSettings } from '../../houston/useTasks'
import { Button, TaskDrawerExecutionPanel } from '../ui'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from '../ui/buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../ui/Icon'
import { IconAgent, IconGitBranch, IconInfo, IconPlay } from '../icons'
import { Select, type SelectOption } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'
import {
  READ_ONLY_REASON,
  TASK_AGENTS,
  formatAge,
  runIsOpen,
  runStateLabel,
  runStateTone,
  taskAgentLabel,
  type ReviewVerdict,
  type TaskReviewOutcome
} from './format'

const REVIEW_VERDICT_LABEL: Readonly<Record<ReviewVerdict, string>> = {
  pass: 'Review passed',
  fail: 'Review failed',
  needs_review: 'Needs review'
}

const REVIEW_VERDICT_TONE: Readonly<Record<ReviewVerdict, 'done' | 'failed' | 'needs'>> = {
  pass: 'done',
  fail: 'failed',
  needs_review: 'needs'
}

function ReviewMeta({ outcome }: { outcome: TaskReviewOutcome }): React.JSX.Element {
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span className="k text-[var(--text-faint)]">Reviewer</span>
        <IconAgent agent={outcome.reviewer} brand className="w-3.5 h-3.5 flex-none" />
        {taskAgentLabel(outcome.reviewer)}
      </span>
      <span className={`tk-st ${REVIEW_VERDICT_TONE[outcome.verdict]}`} data-testid="task-review-verdict">
        {REVIEW_VERDICT_LABEL[outcome.verdict]}
      </span>
    </>
  )
}

function ReviewFindings({ outcome }: { outcome: TaskReviewOutcome }): React.JSX.Element | null {
  if (outcome.findings === null || outcome.verdict === 'pass') return null
  return (
    <div className="findings" data-testid="task-review-findings">
      <Icon glyph={IconInfo} role="small" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{outcome.findings}</span>
    </div>
  )
}

function RunReason({ reason }: { reason: string }): React.JSX.Element {
  return (
    <div className="ask2">
      <Icon glyph={IconInfo} role="small" />
      <span className="min-w-0 flex-1">{reason}</span>
    </div>
  )
}

function RunControlButton({
  testId,
  label,
  primary,
  presentation,
  readOnly,
  onClick
}: {
  testId: string
  label: string
  primary: boolean
  presentation: 'default' | 'drawer'
  readOnly: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="inline-flex">
      {presentation === 'drawer' ? <Button
        variant="secondary"
        data-testid={testId}
        disabled={readOnly}
        onClick={onClick}
      >{label}</Button> : <button
        type="button"
        className={`btn ${primary ? BTN_PRIMARY : BTN_GHOST} ${HIT_TARGET_28}`}
        data-testid={testId}
        disabled={readOnly}
        onClick={onClick}
      >
        {label}
      </button>}
    </Tooltip>
  )
}

function ExecutionActions({
  run,
  session,
  retryRunId,
  readOnly,
  onOpenSession,
  onReview,
  onRunControl,
  presentation
}: {
  run: TaskRun
  session: SessionInfo | undefined
  retryRunId: number | null
  readOnly: boolean
  onOpenSession: (sessionId: number) => void
  onReview: (session: SessionInfo) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
  presentation: 'default' | 'drawer'
}): React.JSX.Element {
  return (
    <div className="f">
      {presentation === 'drawer' && run.state === 'cancelled' && (
        <RunControlButton
          testId="task-run-start-again"
          label="Start again"
          primary
          presentation={presentation}
          readOnly={readOnly}
          onClick={() => onRunControl(run.id, 'resume')}
        />
      )}
      {session && presentation !== 'drawer' && (
        <button
          type="button"
          className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28}`}
          data-testid="task-run-open-session"
          onClick={() => onOpenSession(session.id)}
        >
          Open session
        </button>
      )}
      {session && (
        presentation === 'drawer' ? <Button
          variant="secondary"
          data-testid="task-run-review"
          onClick={() => onReview(session)}
        >Review changes</Button> : <button
          type="button"
          className={`btn ${BTN_SECONDARY} ${HIT_TARGET_28}`}
          data-testid="task-run-review"
          onClick={() => onReview(session)}
        >
          Review changes
        </button>
      )}
      <span className="flex-1" />
      {retryRunId !== null && (
        <RunControlButton
          testId="task-run-retry"
          label="Retry with findings"
          primary
          presentation={presentation}
          readOnly={readOnly}
          onClick={() => onRunControl(retryRunId, 'retry')}
        />
      )}
      {runIsOpen(run.state) && (
        <RunControlButton
          testId="task-run-stop"
          label="Stop"
          primary={false}
          presentation={presentation}
          readOnly={readOnly}
          onClick={() => onRunControl(run.id, 'stop')}
        />
      )}
      {run.state === 'interrupted' && (
        <RunControlButton
          testId="task-run-resume"
          label="Resume"
          primary
          presentation={presentation}
          readOnly={readOnly}
          onClick={() => onRunControl(run.id, 'resume')}
        />
      )}
      {run.state === 'cancelled' && presentation !== 'drawer' && (
        <RunControlButton
          testId="task-run-start-again"
          label="Start again"
          primary
          presentation={presentation}
          readOnly={readOnly}
          onClick={() => onRunControl(run.id, 'resume')}
        />
      )}
    </div>
  )
}

// The "Execution · Attempt N" card: state, branch, provider, reason and the
// actions the run's state allows, plus the reviewer's verdict and findings once
// it settles; "Retry with findings" opens the next attempt with them attached.
export function TaskExecutionCard({
  run,
  sessions,
  now,
  readOnly,
  review,
  onOpenSession,
  onReview,
  onRunControl,
  presentation = 'default',
  branchReuse,
  pullRequestUrl
}: {
  run: TaskRun
  sessions: ReadonlyMap<number, SessionInfo>
  now: number
  readOnly: boolean
  review?: TaskReviewOutcome | null
  onOpenSession: (sessionId: number) => void
  onReview: (session: SessionInfo) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
  presentation?: 'default' | 'drawer'
  branchReuse?: string | null
  pullRequestUrl?: string | null
}): React.JSX.Element {
  const tone = runStateTone(run.state)
  const session = useSession(run.session_id ?? -1, run.session_id != null ? sessions.get(run.session_id) : undefined)
  const reason = run.reason ?? null
  const outcome = review ?? null
  const retryRunId = outcome?.retryRunId ?? null

  if (presentation === 'drawer') return <TaskDrawerExecution
    run={run}
    session={session}
    now={now}
    readOnly={readOnly}
    outcome={outcome}
    reason={reason}
    retryRunId={retryRunId}
    branchReuse={branchReuse}
    pullRequestUrl={pullRequestUrl}
    onOpenSession={onOpenSession}
    onReview={onReview}
    onRunControl={onRunControl}
  />

  return (
    <div
      className={`exec ${run.state === 'waiting_for_input' ? 'needs' : ''}`}
      data-presentation={presentation}
      data-testid="task-execution"
      style={{ marginTop: 10 }}
    >
      <div className="h">
        <span className={`tk-dot ${tone}`} />
        <b>Execution · Attempt {run.attempt}</b>
        <span className={`tk-st ${tone}`}>{runStateLabel(run.state, run.kind)}</span>
        <span className="flex-1" />
        <span className="font-mono text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">{formatAge(run.started_at_ms, now)}</span>
      </div>
      <div className="r">
        {run.branch != null && run.branch !== '' && (
          <span className="chip-branch">
            <Icon glyph={IconGitBranch} role="small" />
            <span className="truncate">{run.branch}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <IconAgent agent={run.provider} brand className="w-3.5 h-3.5 flex-none" />
          {taskAgentLabel(run.provider)}
        </span>
        {outcome && <ReviewMeta outcome={outcome} />}
      </div>
      {outcome !== null && <ReviewFindings outcome={outcome} />}
      {reason !== null && reason !== '' && <RunReason reason={reason} />}
      <ExecutionActions
        run={run}
        session={session}
        retryRunId={retryRunId}
        readOnly={readOnly}
        onOpenSession={onOpenSession}
        onReview={onReview}
        onRunControl={onRunControl}
        presentation="default"
      />
    </div>
  )
}

function TaskDrawerExecution({
  run,
  session,
  now,
  readOnly,
  outcome,
  reason,
  retryRunId,
  branchReuse,
  pullRequestUrl,
  onOpenSession,
  onReview,
  onRunControl
}: {
  run: TaskRun
  session: SessionInfo | undefined
  now: number
  readOnly: boolean
  outcome: TaskReviewOutcome | null
  reason: string | null
  retryRunId: number | null
  branchReuse?: string | null
  pullRequestUrl?: string | null
  onOpenSession: (sessionId: number) => void
  onReview: (session: SessionInfo) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
}): React.JSX.Element {
  const branch = branchReuse ? `Reuses ${branchReuse}` : run.branch ? `Reuses ${run.branch}` : 'Reuses task worktree'
  const pullRequest = pullRequestUrl ? pullRequestNumber(pullRequestUrl) : null
  const age = runIsOpen(run.state) ? formatAge(run.started_at_ms, now) : `Stopped ${formatAge(run.ended_at_ms ?? run.started_at_ms, now)} ago`
  const status = runIsOpen(run.state) ? runStateLabel(run.state, run.kind) : 'Idle'

  return <TaskDrawerExecutionPanel
    tone={run.state === 'waiting_for_input' ? 'needs' : runStateTone(run.state)}
    status={status}
    metadata={`${age} · Attempt ${run.attempt} · ${run.provider === 'claude' ? 'Claude Code' : taskAgentLabel(run.provider)}`}
    reuse={`${branch} · ${pullRequest ? `pull request #${pullRequest}` : 'no pull request yet'}`}
  >
    {outcome !== null && <ReviewFindings outcome={outcome} />}
    {reason !== null && reason !== '' && <RunReason reason={reason} />}
    <ExecutionActions
      run={run}
      session={session}
      retryRunId={retryRunId}
      readOnly={readOnly}
      onOpenSession={onOpenSession}
      onReview={onReview}
      onRunControl={onRunControl}
      presentation="drawer"
    />
  </TaskDrawerExecutionPanel>
}

function pullRequestNumber(url: string): string | null {
  return url.match(/\/pull\/(\d+)(?:\/|[?#]|$)/)?.[1] ?? null
}

// The execution card's slot for a task no run has opened. The mock has no
// screen for this state: it borrows the execution card's own classes, with the
// Start menu's agent choice folded into one row.
export function TaskStartCard({
  task,
  settings,
  workspaceOptions = [],
  readOnly,
  onStart
}: {
  task: Task
  settings: TaskStartSettings | null
  workspaceOptions?: SelectOption[]
  readOnly: boolean
  onStart: (id: number, agent: AgentKind, workspace?: string | null) => void
}): React.JSX.Element {
  const [chosen, setChosen] = useState<AgentKind | null>(null)
  const agent = chosen ?? settings?.agent ?? 'claude'
  const [workspace, setWorkspace] = useState('')
  const disabled = readOnly
  const startDisabled = disabled || (task.workspace == null && workspace === '')

  return (
    <div className="exec" data-testid="task-start-card" style={{ marginTop: 10 }}>
      <div className="h">
        <span className="tk-dot idle" />
        <b>Execution</b>
        <span className="tk-st idle">Not started</span>
      </div>
      <div className="f">
        {task.workspace == null && <Select aria-label="Start in workspace" data-testid="task-start-workspace" value={workspace} options={[{ value: '', label: 'Choose workspace' }, ...workspaceOptions]} disabled={readOnly} onChange={setWorkspace} />}
        <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="inline-flex">
          <Select
            aria-label="Start with an agent"
            data-testid="task-start-agent"
            value={agent}
            options={TASK_AGENT_OPTIONS}
            disabled={disabled}
            prefix={<IconAgent agent={agent} brand className="w-3.5 h-3.5 flex-none" />}
            className="min-w-[132px]"
            onChange={(value) => setChosen(value as AgentKind)}
          />
        </Tooltip>
        <span className="flex-1" />
        <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="inline-flex">
          <button
            type="button"
            className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28}`}
            data-testid="task-start"
            disabled={startDisabled}
            onClick={() => onStart(task.id, agent, task.workspace == null ? workspace : null)}
          >
            <Icon glyph={IconPlay} role="small" />
            Start
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

const TASK_AGENT_OPTIONS: SelectOption[] = TASK_AGENTS.map((value) => ({
  value,
  label: taskAgentLabel(value)
}))

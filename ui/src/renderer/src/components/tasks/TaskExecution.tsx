import { useSession } from '../../sessionsStore'
import { useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo } from '../../houston/client'
import type { Task } from '../../houston/generated/Task'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunAction } from '../../houston/generated/TaskRunAction'
import type { TaskStartSettings } from '../../houston/useTasks'
import { isPullRequestUrl } from '../../houston/taskDomain'
import {
  BulletList,
  Button,
  CopyChip,
  Disclosure,
  Inline,
  InlineLink,
  MonoBlock,
  StatusLabel,
  TaskAgentIcon,
  TaskAgentTag,
  TaskButton,
  TaskCardActions,
  TaskDot,
  TaskDrawerExecutionPanel,
  TaskExecCard,
  TaskExecDetails,
  TaskExecHeader,
  TaskExecTitle,
  TaskMono,
  TaskRunNote,
  TaskReviewVerdict,
  TaskStartSelect,
  TaskStateText,
  TaskTagChip,
  Text
} from '../ui'
import { Icon } from '../ui/Icon'
import { IconGitBranch, IconPlay } from '../icons'
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
      <TaskAgentTag agent={outcome.reviewer} label={taskAgentLabel(outcome.reviewer)} prefix="Reviewer" size="compact" tone="secondary" />
      <TaskReviewVerdict tone={REVIEW_VERDICT_TONE[outcome.verdict]} data-testid="task-review-verdict">
        {REVIEW_VERDICT_LABEL[outcome.verdict]}
      </TaskReviewVerdict>
    </>
  )
}

function ReviewFindings({ outcome }: { outcome: TaskReviewOutcome }): React.JSX.Element | null {
  if (outcome.findings === null || outcome.verdict === 'pass') return null
  return (
    <TaskRunNote kind="findings" data-testid="task-review-findings">
      {outcome.findings}
    </TaskRunNote>
  )
}

function RunReason({ reason }: { reason: string }): React.JSX.Element {
  return (
    <TaskRunNote kind="reason">{reason}</TaskRunNote>
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
      >{label}</Button> : <TaskButton
        tone={primary ? 'primary' : 'ghost'}
        data-testid={testId}
        disabled={readOnly}
        onClick={onClick}
      >
        {label}
      </TaskButton>}
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
    <TaskCardActions>
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
        <TaskButton tone="primary" data-testid="task-run-open-session" onClick={() => onOpenSession(session.id)}>
          Open session
        </TaskButton>
      )}
      {session && (
        presentation === 'drawer' ? <Button
          variant="secondary"
          data-testid="task-run-review"
          onClick={() => onReview(session)}
        >Review changes</Button> : <TaskButton tone="secondary" data-testid="task-run-review" onClick={() => onReview(session)}>
          Review changes
        </TaskButton>
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
    </TaskCardActions>
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
    <TaskExecCard run needs={run.state === 'waiting_for_input'} data-testid="task-execution">
      <TaskExecHeader>
        <TaskDot tone={tone} />
        <TaskExecTitle>Execution · Attempt {run.attempt}</TaskExecTitle>
        <TaskStateText tone={tone}>{runStateLabel(run.state, run.kind)}</TaskStateText>
        <span className="flex-1" />
        <TaskMono faint label>{formatAge(run.started_at_ms, now)}</TaskMono>
      </TaskExecHeader>
      <TaskExecDetails>
        {run.branch != null && run.branch !== '' && (
          <TaskTagChip>
            <Icon glyph={IconGitBranch} role="small" />
            <span className="truncate">{run.branch}</span>
          </TaskTagChip>
        )}
        <TaskAgentTag agent={run.provider} label={taskAgentLabel(run.provider)} size="compact" tone="secondary" />
        {outcome && <ReviewMeta outcome={outcome} />}
      </TaskExecDetails>
      {outcome !== null && <ReviewFindings outcome={outcome} />}
      {reason !== null && reason !== '' && <RunReason reason={reason} />}
      <RunProof run={run} pullRequestUrl={pullRequestUrl ?? null} />
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
    </TaskExecCard>
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
  const pullRequest = run.pr_number ?? (pullRequestUrl ? pullRequestNumber(pullRequestUrl) : null)
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
    <RunProof run={run} pullRequestUrl={pullRequestUrl ?? null} />
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

// A git short hash, as `git log --oneline` prints it.
const SHORT_SHA = 7

// What the agent's handback reported: the pull request, the pushed commit, the
// commands it says it ran with their output, the capture and what becomes
// permanent. Houston did not run these checks, so the labels say so.
function RunProof({ run, pullRequestUrl }: { run: TaskRun; pullRequestUrl: string | null }): React.JSX.Element | null {
  const url = pullRequestUrl ?? (run.pr_url && isPullRequestUrl(run.pr_url) ? run.pr_url : null)
  const number = run.pr_number ?? (url ? pullRequestNumber(url) : null)
  const sha = run.pushed_sha ?? null
  const evidence = run.evidence ?? null
  if (number == null && !sha && !evidence) return null
  return (
    <section aria-label="Run proof" data-testid="task-run-proof" className="grid gap-[var(--space-2)]">
      {(number != null || sha) && <Inline wrap gap="small">
        {number != null && (url ? <InlineLink href={url}>Pull request #{number}</InlineLink> : <Text size="small">Pull request #{number}</Text>)}
        {sha && <Text as="span" size="small" tone="muted">Pushed <CopyChip value={sha} className="font-mono">{sha.slice(0, SHORT_SHA)}</CopyChip></Text>}
      </Inline>}
      {evidence && evidence.verification.length > 0 && <div className="grid gap-[var(--space-1)]">
        <Text size="small" weight="semibold">Verification reported by the agent</Text>
        {evidence.verification.map((check, index) => (
          <Disclosure key={index} summary={<span className="inline-flex min-w-0 items-center gap-[var(--space-2)]">
            <StatusLabel status={check.passed ? 'Passed' : 'Failed'} size="small" />
            <Text as="span" size="small" mono className="truncate">{check.command}</Text>
          </span>}>
            <MonoBlock variant="reason" data-testid="task-run-verification-output">{check.output || 'No output recorded.'}</MonoBlock>
          </Disclosure>
        ))}
      </div>}
      {evidence?.capture_path && <div className="grid gap-[var(--space-1)]">
        <Text size="small" weight="semibold">Capture</Text>
        <div><CopyChip value={evidence.capture_path} className="font-mono">{evidence.capture_path}</CopyChip></div>
      </div>}
      {evidence && evidence.permanent.length > 0 && <div className="grid gap-[var(--space-1)]">
        <Text size="small" weight="semibold">What becomes permanent</Text>
        <BulletList items={evidence.permanent} />
      </div>}
    </section>
  )
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
    <TaskExecCard start data-testid="task-start-card">
      <TaskExecHeader>
        <TaskDot tone="idle" />
        <TaskExecTitle>Execution</TaskExecTitle>
        <TaskStateText tone="idle">Not started</TaskStateText>
      </TaskExecHeader>
      <TaskCardActions>
        {task.workspace == null && <Select aria-label="Start in workspace" data-testid="task-start-workspace" value={workspace} options={[{ value: '', label: 'Choose workspace' }, ...workspaceOptions]} disabled={readOnly} onChange={setWorkspace} />}
        <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="inline-flex">
          <TaskStartSelect
            aria-label="Start with an agent"
            data-testid="task-start-agent"
            value={agent}
            options={TASK_AGENT_OPTIONS}
            disabled={disabled}
            prefix={<TaskAgentIcon agent={agent} />}
            onChange={(value) => setChosen(value as AgentKind)}
          />
        </Tooltip>
        <span className="flex-1" />
        <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="inline-flex">
          <TaskButton
            tone="primary"
            data-testid="task-start"
            disabled={startDisabled}
            onClick={() => onStart(task.id, agent, task.workspace == null ? workspace : null)}
          >
            <Icon glyph={IconPlay} role="small" />
            Start
          </TaskButton>
        </Tooltip>
      </TaskCardActions>
    </TaskExecCard>
  )
}

const TASK_AGENT_OPTIONS: SelectOption[] = TASK_AGENTS.map((value) => ({
  value,
  label: taskAgentLabel(value)
}))

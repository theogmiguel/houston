import { useEffect, useState, type ReactNode } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo } from '../../houston/client'
import type { TaskAcceptanceItem } from '../../houston/generated/TaskAcceptanceItem'
import type { TaskComment } from '../../houston/generated/TaskComment'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunAction } from '../../houston/generated/TaskRunAction'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import type { TaskDetailData, TaskRefusal, TaskStartSettings } from '../../houston/useTasks'
import { BTN_GHOST, BTN_SECONDARY } from '../buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../Icon'
import {
  IconAgent,
  IconAlertTriangle,
  IconArchive,
  IconCheck,
  IconChevronLeft,
  IconCopy,
  IconCornerDownRight,
  IconEllipsis,
  IconGitFork,
  IconMessageSquare,
  IconPencil,
  IconPlay,
  IconPlus,
  IconUndo,
  IconUser
} from '../icons'
import { Select, type SelectOption } from '../Select'
import { Tooltip } from '../Tooltip'
import {
  acceptanceText,
  actorLabel,
  formatAge,
  formatAgo,
  historyLine,
  PRIORITY_LABEL,
  READ_ONLY_REASON,
  STATUS_LABEL,
  STATUS_ORDER,
  taskAgentLabel,
  taskReviewer,
  taskReviewOutcome
} from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'
import { TaskExecutionCard, TaskStartCard } from './TaskExecution'
import { TaskMenu } from './TaskMenu'
import { TaskProgress, Chip } from '../ui'

export interface TaskDetailProps {
  detail: TaskDetailData
  access: TasksAccess | null
  refusal: TaskRefusal | null
  now: number
  parentOptions: SelectOption[]
  workspaceOptions?: SelectOption[]
  sessions: ReadonlyMap<number, SessionInfo>
  startSettings: TaskStartSettings | null
  onBack: () => void
  onReload: (id: number) => void
  onSave: (id: number, expectedRevision: number, patch: TaskPatch) => void
  onCheck: (id: number, item: number, checked: boolean) => void
  onComment: (id: number, body: string) => void
  onArchive: (id: number, archived: boolean, expectedRevision: number) => void
  onStart: (id: number, agent: AgentKind, workspace?: string | null) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
  onOpenSession: (sessionId: number) => void
  onReview: (session: SessionInfo) => void
  presentation?: 'side' | 'drawer'
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const { detail, refusal, now } = props
  const { task } = detail
  const readOnly = false
  const [title, setTitle] = useServerDraft(task.title, task.revision)
  const [description, setDescription] = useServerDraft(task.description, task.revision)
  const archived = task.archived_at_ms != null
  const latestRun = detail.runs[0] ?? null
  const startable = !archived && (task.status === 'backlog' || task.status === 'todo')
  const reviewer = taskReviewer(detail.runs)
  const review = taskReviewOutcome(detail.runs, detail.comments)
  const drawer = props.presentation === 'drawer'

  return (
    <div className="tasks-root" data-testid="task-detail">
      {!drawer && <div className="tk-head">
        <button type="button" className={`btn ${BTN_GHOST} ${HIT_TARGET_28}`} onClick={props.onBack}>
          <Icon glyph={IconChevronLeft} role="small" />
          Tasks
        </button>
        <span className="font-mono text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">{task.key}</span>
        <span className="spacer" />
        <CopyKeyButton taskKey={task.key} />
        <TaskMenu
          label="Task actions"
          icon={IconEllipsis}
          testId="task-detail-menu"
          sections={[
            {
              items: [
                {
                  id: 'task-archive',
                  label: archived ? 'Restore task' : 'Archive task',
                  disabled: readOnly,
                  disabledReason: readOnly ? READ_ONLY_REASON : undefined,
                  onSelect: () => props.onArchive(task.id, !archived, task.revision)
                }
              ]
            }
          ]}
        />
      </div>}
      {refusal && refusal.id === task.id && <RefusalBanner refusal={refusal} onReload={props.onReload} taskId={task.id} />}
      <div className="tk-detail">
        {!drawer && <input
          className="tk-title-input"
          aria-label="Task title"
          value={title}
          disabled={readOnly}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => commitTitle({ title, task, onSave: props.onSave, setTitle })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setTitle(task.title)
          }}
        />}
        {!drawer && <div className="sub3">
          <span>created by {task.created_by === 'user' ? 'you' : task.created_by}</span>
          <span>·</span>
          <span>{formatAgo(task.created_at_ms, now)}</span>
          <span>·</span>
          <span className="font-mono">revision {task.revision}</span>
          {archived && (
            <>
              <span>·</span>
              <span>archived {formatAgo(task.archived_at_ms ?? task.updated_at_ms, now)}</span>
            </>
          )}
        </div>}
        {drawer && <div className="px-[var(--space-3)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{task.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No workspace'}</div>}
        {drawer && <div className="px-[var(--space-3)] pt-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{title}</div>}
        {drawer && <div className="px-[var(--space-3)] pt-[var(--space-3)]"><TaskProgress status={task.status} /></div>}
        {!drawer && <div className="tk-props">
          <Select aria-label="Workspace" data-testid="task-workspace" value={task.workspace ?? ''} options={[{ value: '', label: 'No workspace' }, ...(props.workspaceOptions ?? [])]} disabled={readOnly} prefix={<span className="k">Workspace</span>} chrome="prop-select" onChange={(value) => props.onSave(task.id, task.revision, { workspace: value || null })} />
          <Select
            aria-label="Status"
            data-testid="task-status"
            value={task.status}
            options={STATUS_OPTIONS}
            disabled={readOnly}
            prefix={<TaskStatusGlyph status={task.status} />}
            chrome="prop-select"
            onChange={(value) => props.onSave(task.id, task.revision, { status: value as TaskStatus })}
          />
          <Select
            aria-label="Priority"
            data-testid="task-priority"
            value={task.priority}
            options={PRIORITY_OPTIONS}
            disabled={readOnly}
            prefix={<TaskPriorityGlyph priority={task.priority} />}
            chrome="prop-select"
            onChange={(value) => props.onSave(task.id, task.revision, { priority: value as TaskPriority })}
          />
          <Select
            aria-label="Parent"
            data-testid="task-parent"
            value={task.parent_id == null ? '' : String(task.parent_id)}
            options={[{ value: '', label: 'None' }, ...props.parentOptions]}
            disabled={readOnly}
            prefix={<span className="k">Parent</span>}
            chrome="prop-select"
            onChange={(value) => props.onSave(task.id, task.revision, { parent_id: value === '' ? null : Number(value) })}
          />
          {reviewer !== null && (
            <span className="prop" data-testid="task-reviewer-prop">
              <span className="k">Reviewer</span>
              <IconAgent agent={reviewer} brand className="w-3.5 h-3.5 flex-none" />
              {taskAgentLabel(reviewer)}
            </span>
          )}
        </div>}
        {!drawer && <>
        <SectionHeading heading="Description" />
        <textarea
          className="tk-desc-input"
          aria-label="Task description"
          rows={Math.max(2, description.split('\n').length)}
          placeholder="No description."
          value={description}
          disabled={readOnly}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => {
            if (description !== task.description) props.onSave(task.id, task.revision, { description })
          }}
        />
        </>}
        {latestRun ? (
          <TaskExecutionCard
            run={latestRun}
            sessions={props.sessions}
            now={now}
            readOnly={readOnly}
            review={review}
            onOpenSession={props.onOpenSession}
            onReview={props.onReview}
            onRunControl={props.onRunControl}
          />
        ) : (
          startable && <TaskStartCard task={task} settings={props.startSettings} workspaceOptions={props.workspaceOptions} readOnly={readOnly} onStart={props.onStart} />
        )}
        <SectionHeading
          heading="Acceptance"
          trailing={acceptanceText(
            detail.acceptance.filter((item) => item.checked_at_ms != null).length,
            detail.acceptance.length
          )}
        />
        <AcceptanceList
          items={detail.acceptance}
          readOnly={readOnly}
          onCheck={(item, checked) => props.onCheck(task.id, item, checked)}
        />
        {drawer && task.origin?.kind === 'harness_finding' && <div className="px-[var(--space-3)] pt-[var(--space-2)]"><Chip variant="compound" label={`From Harness finding · ${task.origin.key}`} /></div>}
        {!drawer && <>
          <SectionHeading heading="Activity" />
          <ActivityFeed history={detail.history} comments={detail.comments} runs={detail.runs} now={now} />
          <CommentComposer readOnly={readOnly} onSubmit={(body) => props.onComment(task.id, body)} />
        </>}
      </div>
    </div>
  )
}

function commitTitle({ title, task, onSave, setTitle }: {
  title: string
  task: TaskDetailData['task']
  onSave: TaskDetailProps['onSave']
  setTitle: (value: string) => void
}): void {
  const next = title.trim()
  if (next === '' ) {
    setTitle(task.title)
    return
  }
  if (next !== task.title) onSave(task.id, task.revision, { title: next })
}

function useServerDraft(server: string, revision: number): [string, (value: string) => void] {
  const [draft, setDraft] = useState(server)
  useEffect(() => {
    setDraft(server)
  }, [server, revision])
  return [draft, setDraft]
}

function SectionHeading({ heading, trailing }: { heading: string; trailing?: string }): React.JSX.Element {
  return (
    <div className="tk-sec">
      <span>{heading}</span>
      {trailing && <span className="font-mono tracking-normal">{trailing}</span>}
    </div>
  )
}

function CopyKeyButton({ taskKey }: { taskKey: string }): React.JSX.Element {
  return (
    <Tooltip label="Copy task key" className="inline-flex">
      <button
        type="button"
        aria-label="Copy task key"
        data-testid="task-copy-key"
        className={`tk-ibtn ${HIT_TARGET_28}`}
        onClick={() => void navigator.clipboard?.writeText(taskKey).catch(() => {})}
      >
        <Icon glyph={IconCopy} role="small" />
      </button>
    </Tooltip>
  )
}

function RefusalBanner({
  refusal,
  taskId,
  onReload
}: {
  refusal: TaskRefusal
  taskId: number
  onReload: (id: number) => void
}): React.JSX.Element {
  if (refusal.kind === 'conflict') {
    return (
      <div className="tk-banner" data-testid="task-conflict-banner">
        <Icon glyph={IconAlertTriangle} role="small" />
        <span className="msg">
          This task changed elsewhere
          <span className="block text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">{refusal.message}</span>
        </span>
        <button type="button" className={`btn ${BTN_SECONDARY} ${HIT_TARGET_28}`} onClick={() => onReload(taskId)}>
          Reload
        </button>
      </div>
    )
  }
  return (
    <div className="tk-banner error" data-testid="task-refusal">
      <Icon glyph={IconAlertTriangle} role="small" />
      <span className="msg">{refusal.message}</span>
    </div>
  )
}

function AcceptanceList({
  items,
  readOnly,
  onCheck
}: {
  items: TaskAcceptanceItem[]
  readOnly: boolean
  onCheck: (itemId: number, checked: boolean) => void
}): React.JSX.Element {
  if (items.length === 0) return <div className="tk-body muted">No acceptance items.</div>
  return (
    <div className="tk-body flex flex-col">
      {items.map((item) => (
        <Tooltip key={item.id} label={readOnly ? READ_ONLY_REASON : undefined} className="flex">
          <button
            type="button"
            role="checkbox"
            aria-checked={item.checked_at_ms != null}
            disabled={readOnly}
            data-testid={`task-acceptance-${item.id}`}
            className={`chkl ${item.checked_at_ms != null ? 'on' : ''}`}
            onClick={() => onCheck(item.id, item.checked_at_ms == null)}
          >
            <span className="bx">{item.checked_at_ms != null && <Icon glyph={IconCheck} role="small" />}</span>
            <span className="tx">{item.text}</span>
            {item.checked_by && <span className="by">{actorLabel(item.checked_by)}</span>}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

interface ActivityEntry {
  key: string
  at: number
  actor: string
  icon: ReactNode
  verb: string
  detail?: string
  system?: string
  comment?: string
}

const HISTORY_ICON: Readonly<Record<string, ReactNode>> = {
  create: <Icon glyph={IconPlus} role="small" />,
  update: <Icon glyph={IconPencil} role="small" />,
  check: <Icon glyph={IconCheck} role="small" />,
  uncheck: <Icon glyph={IconCheck} role="small" />,
  archive: <Icon glyph={IconArchive} role="small" />,
  restore: <Icon glyph={IconUndo} role="small" />,
  claim: <Icon glyph={IconUser} role="small" />,
  handback: <Icon glyph={IconCornerDownRight} role="small" />,
  start: <Icon glyph={IconPlay} role="small" />,
  resume: <Icon glyph={IconPlay} role="small" />,
  pane_working: <span className="tk-dot working" />,
  pr_merged: <Icon glyph={IconGitFork} role="small" />,
  default: <Icon glyph={IconPencil} role="small" />
}

function activityEntries(
  history: TaskHistoryEntry[],
  comments: TaskComment[],
  runs: readonly TaskRun[]
): ActivityEntry[] {
  const entries: ActivityEntry[] = []
  for (const entry of history) {
    const line = historyLine(entry, runs)
    if (!line) continue
    entries.push({
      key: `h${entry.id}`,
      at: entry.created_at_ms,
      actor: entry.actor,
      icon: HISTORY_ICON[entry.action] ?? HISTORY_ICON.default,
      verb: line.verb,
      detail: line.detail,
      system: line.system
    })
  }
  for (const comment of comments) {
    entries.push({
      key: `c${comment.id}`,
      at: comment.created_at_ms,
      actor: comment.author,
      icon: <Icon glyph={IconMessageSquare} role="small" />,
      verb: 'commented',
      comment: comment.body
    })
  }
  return entries.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
}

function ActivityFeed({
  history,
  comments,
  runs,
  now
}: {
  history: TaskHistoryEntry[]
  comments: TaskComment[]
  runs: readonly TaskRun[]
  now: number
}): React.JSX.Element {
  const entries = activityEntries(history, comments, runs)
  if (entries.length === 0) return <div className="tk-body muted">No activity yet.</div>
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.key} className="act" data-testid="task-activity">
          <span className="ic">{entry.icon}</span>
          <span>
            <b>{actorLabel(entry.actor)}</b> {entry.verb}
            {entry.detail && <span className="muted"> {entry.detail}</span>}
            {entry.system && <span className="sysmark">{entry.system}</span>}
            {entry.comment && <div className="bubble">{entry.comment}</div>}
          </span>
          <span className="tm">{formatAge(entry.at, now)}</span>
        </div>
      ))}
    </>
  )
}

function CommentComposer({
  readOnly,
  onSubmit
}: {
  readOnly: boolean
  onSubmit: (body: string) => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const submit = (): void => {
    const text = body.trim()
    if (text === '' || readOnly) return
    onSubmit(text)
    setBody('')
  }
  return (
    <div className="composer">
      <textarea
        aria-label="Leave a comment"
        placeholder="Leave a comment…"
        value={body}
        disabled={readOnly}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="inline-flex">
        <button
          type="button"
          className={`btn ${BTN_SECONDARY} ${HIT_TARGET_28}`}
          data-testid="task-comment-submit"
          disabled={readOnly || body.trim() === ''}
          onClick={submit}
        >
          Comment
        </button>
      </Tooltip>
    </div>
  )
}

const STATUS_OPTIONS: SelectOption[] = STATUS_ORDER.map((status) => ({
  value: status,
  label: STATUS_LABEL[status]
}))

const PRIORITY_OPTIONS: SelectOption[] = (['urgent', 'high', 'medium', 'low', 'none'] as TaskPriority[]).map(
  (priority) => ({ value: priority, label: PRIORITY_LABEL[priority] })
)

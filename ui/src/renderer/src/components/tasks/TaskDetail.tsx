import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo } from '../../houston/client'
import type { TaskAcceptanceItem } from '../../houston/generated/TaskAcceptanceItem'
import type { TaskComment } from '../../houston/generated/TaskComment'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskLink } from '../../houston/generated/TaskLink'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunAction } from '../../houston/generated/TaskRunAction'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import type { TaskDetailData, TaskRefusal, TaskStartSettings } from '../../houston/useTasks'
import { openExternal } from '../../houston/bridge'
import { Icon } from '../ui/Icon'
import {
  IconAlertTriangle,
  IconArchive,
  IconCheck,
  IconChevronLeft,
  IconClose,
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
import { Select, type SelectOption } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'
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
import {
  Button,
  Chip,
  Notice,
  TaskAcceptanceRow,
  TaskActivityActor,
  TaskActivityBubble,
  TaskActivityIcon,
  TaskActivityRow,
  TaskActivityTime,
  TaskAgentIcon,
  TaskBanner,
  TaskBannerDetail,
  TaskBannerMessage,
  TaskBody,
  TaskButton,
  TaskCheckButton,
  TaskCommentBox,
  TaskCommentField,
  TaskDescriptionField,
  TaskDetailFrame,
  TaskDot,
  TaskDrawerCard,
  TaskDrawerHeader,
  TaskDrawerOrigin,
  TaskIconButton,
  TaskMetaLine,
  TaskMono,
  TaskPanel,
  TaskProp,
  TaskPropKey,
  TaskPropRow,
  TaskRecordBody,
  TaskSectionLabel,
  TaskSystemMark,
  TaskTitleField,
  TaskToolbar
} from '../ui'

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
  onStart: (id: number, agent: AgentKind, workspace?: string | null, force?: boolean) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
  /// Opens a GitHub issue for the task; absent hides the action.
  onOpenIssue?: (id: number) => void
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
  const startAnyway = useStartAnyway(props.onStart)

  if (drawer) return <TaskDetailDrawer props={{ ...props, onStart: startAnyway.start }} taskTitle={title} onStartAnyway={startAnyway.force} />

  return (
    <TaskPanel data-testid="task-detail">
      <TaskToolbar>
        <TaskButton tone="ghost" density="toolbar" onClick={props.onBack}>
          <Icon glyph={IconChevronLeft} role="small" />
          Tasks
        </TaskButton>
        <TaskMono faint label>{task.key}</TaskMono>
        <span className="flex-1" />
        <CopyKeyButton taskKey={task.key} />
        <TaskMenu
          label="Task actions"
          icon={IconEllipsis}
          testId="task-detail-menu"
          sections={[
            {
              items: [
                ...openIssueItems(task, props.onOpenIssue),
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
      </TaskToolbar>
      {refusal && refusal.id === task.id && <RefusalBanner refusal={refusal} onReload={props.onReload} taskId={task.id} onStartAnyway={startAnyway.force} />}
      <TaskRecordBody>
        <TaskTitleField
          aria-label="Task title"
          value={title}
          disabled={readOnly}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => commitTitle({ title, task, onSave: props.onSave, setTitle })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setTitle(task.title)
          }}
        />
        <TaskMetaLine>
          <span>created by {task.created_by === 'user' ? 'you' : task.created_by}</span>
          <span>·</span>
          <span>{formatAgo(task.created_at_ms, now)}</span>
          <span>·</span>
          <TaskMono>revision {task.revision}</TaskMono>
          {archived && (
            <>
              <span>·</span>
              <span>archived {formatAgo(task.archived_at_ms ?? task.updated_at_ms, now)}</span>
            </>
          )}
        </TaskMetaLine>
        <TaskPropRow>
          <Select aria-label="Workspace" data-testid="task-workspace" value={task.workspace ?? ''} options={[{ value: '', label: 'No workspace' }, ...(props.workspaceOptions ?? [])]} disabled={readOnly} prefix={<span>Workspace</span>} variant="property-chip" onChange={(value) => props.onSave(task.id, task.revision, { workspace: value || null })} />
          <Select
            aria-label="Status"
            data-testid="task-status"
            value={task.status}
            options={STATUS_OPTIONS}
            disabled={readOnly}
            prefix={<TaskStatusGlyph status={task.status} />}
            variant="property-chip"
            onChange={(value) => props.onSave(task.id, task.revision, { status: value as TaskStatus })}
          />
          <Select
            aria-label="Priority"
            data-testid="task-priority"
            value={task.priority}
            options={PRIORITY_OPTIONS}
            disabled={readOnly}
            prefix={<TaskPriorityGlyph priority={task.priority} />}
            variant="property-chip"
            onChange={(value) => props.onSave(task.id, task.revision, { priority: value as TaskPriority })}
          />
          <Select
            aria-label="Parent"
            data-testid="task-parent"
            value={task.parent_id == null ? '' : String(task.parent_id)}
            options={[{ value: '', label: 'None' }, ...props.parentOptions]}
            disabled={readOnly}
            prefix={<span>Parent</span>}
            variant="property-chip"
            onChange={(value) => props.onSave(task.id, task.revision, { parent_id: value === '' ? null : Number(value) })}
          />
          <BlockedBy
            blockedBy={task.blocked_by}
            options={props.parentOptions.filter((option) => option.value !== String(task.id))}
            disabled={readOnly}
            onChange={(next) => props.onSave(task.id, task.revision, { blocked_by: next })}
          />
          {reviewer !== null && (
            <TaskProp data-testid="task-reviewer-prop">
              <TaskPropKey>Reviewer</TaskPropKey>
              <TaskAgentIcon agent={reviewer} />
              {taskAgentLabel(reviewer)}
            </TaskProp>
          )}
        </TaskPropRow>
        <TaskLinks links={task.links} />
        <TaskSectionLabel heading="Description" />
        <TaskDescriptionField
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
          startable && <TaskStartCard task={task} settings={props.startSettings} workspaceOptions={props.workspaceOptions} readOnly={readOnly} onStart={startAnyway.start} />
        )}
        <TaskSectionLabel
          heading="Acceptance"
          trailing={acceptanceText(detail.acceptance.filter((item) => item.checked_at_ms != null).length, detail.acceptance.length)}
        />
        <AcceptanceList
          items={detail.acceptance}
          readOnly={readOnly}
          presentation="side"
          onCheck={(item, checked) => props.onCheck(task.id, item, checked)}
        />
          <TaskSectionLabel heading="Activity" />
          <ActivityFeed history={detail.history} comments={detail.comments} runs={detail.runs} now={now} />
          <CommentComposer readOnly={readOnly} onSubmit={(body) => props.onComment(task.id, body)} />
      </TaskRecordBody>
    </TaskPanel>
  )
}

function TaskDetailDrawer({ props, taskTitle, onStartAnyway }: { props: TaskDetailProps; taskTitle: string; onStartAnyway: () => void }): React.JSX.Element {
  const { detail, now } = props
  const { task } = detail
  const latestRun = detail.runs[0] ?? null
  const archived = task.archived_at_ms != null
  const startable = !archived && (task.status === 'backlog' || task.status === 'todo')
  const review = taskReviewOutcome(detail.runs, detail.comments)
  const checked = detail.acceptance.filter((item) => item.checked_at_ms != null).length

  return <TaskDetailFrame>
    {props.refusal && props.refusal.id === task.id && <RefusalBanner refusal={props.refusal} onReload={props.onReload} taskId={task.id} onStartAnyway={onStartAnyway} />}
    <TaskDrawerHeader
      taskKey={task.key}
      workspace={task.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No workspace'}
      heading={taskTitle}
      status={task.status}
      actions={<>
        <Button variant="icon" icon={IconClose} aria-label="Close task details" onClick={props.onBack} />
        <TaskMenu
          label="Task actions"
          icon={IconEllipsis}
          testId="task-detail-menu"
          sections={[{ items: [
            ...(latestRun?.session_id != null ? [{ id: 'task-open-session', label: 'Open session', onSelect: () => props.onOpenSession(latestRun.session_id!) }] : []),
            { id: 'task-copy-key', label: 'Copy task key', onSelect: () => void navigator.clipboard?.writeText(task.key).catch(() => {}) },
            ...openIssueItems(task, props.onOpenIssue),
            { id: 'task-archive', label: archived ? 'Restore task' : 'Archive task', onSelect: () => props.onArchive(task.id, !archived, task.revision) }
          ] }]}
        />
      </>}
    />
    {latestRun && <TaskExecutionCard
      run={latestRun}
      sessions={props.sessions}
      now={now}
      readOnly={false}
      review={review}
      onOpenSession={props.onOpenSession}
      onReview={props.onReview}
      onRunControl={props.onRunControl}
      presentation="drawer"
      branchReuse={latestRun.branch ?? null}
      pullRequestUrl={task.ref_url ?? null}
    />}
    {!latestRun && startable && <TaskStartCard task={task} settings={props.startSettings} workspaceOptions={props.workspaceOptions} readOnly={false} onStart={props.onStart} />}
    <div className="grid gap-[var(--space-2)]">
      <TaskSectionLabel heading="Acceptance" trailing={`${checked}/${detail.acceptance.length}`} />
      <TaskDrawerCard><AcceptanceList
        items={detail.acceptance}
        readOnly={false}
        presentation="drawer"
        onCheck={(item, isChecked) => props.onCheck(task.id, item, isChecked)}
      /></TaskDrawerCard>
      {task.origin?.kind === 'harness_finding' && <TaskDrawerOrigin><Chip variant="compound" label={`From Harness finding · ${task.origin.key}`} /></TaskDrawerOrigin>}
      <TaskLinks links={task.links} />
    </div>
  </TaskDetailFrame>
}

/** The tasks this one waits for: a chip each, removable, and a picker to add one. */
function BlockedBy({
  blockedBy,
  options,
  disabled,
  onChange
}: {
  blockedBy: number[]
  options: SelectOption[]
  disabled: boolean
  onChange: (next: number[]) => void
}): React.JSX.Element {
  const label = (id: number): string => options.find((option) => option.value === String(id))?.label ?? `#${id}`
  const remaining = options.filter((option) => !blockedBy.includes(Number(option.value)))
  return (
    <span className="inline-flex items-center gap-[var(--space-1)]" data-testid="task-blocked-by">
      {blockedBy.map((id) => (
        <Chip key={id} variant="removable" label={label(id)} disabled={disabled} onRemove={() => onChange(blockedBy.filter((other) => other !== id))} />
      ))}
      <Select
        aria-label="Blocked by"
        data-testid="task-add-blocker"
        value=""
        options={[{ value: '', label: blockedBy.length > 0 ? 'Add blocker' : 'Blocked by: none' }, ...remaining]}
        disabled={disabled}
        variant="property-chip"
        onChange={(value) => {
          if (value !== '') onChange([...blockedBy, Number(value)])
        }}
      />
    </span>
  )
}

/** "Open GitHub issue" while the task mirrors none; the daemon names any refusal. */
function openIssueItems(task: TaskDetailData['task'], onOpenIssue?: (id: number) => void): { id: string; label: string; onSelect: () => void }[] {
  if (!onOpenIssue || task.links.some((link) => link.provider === 'github')) return []
  return [{ id: 'task-open-issue', label: 'Open GitHub issue', onSelect: () => onOpenIssue(task.id) }]
}

const LINK_PROVIDER_LABEL: Record<string, string> = { slack: 'Slack', github: 'GitHub' }

/** The external items a task mirrors; a chip opens the item's page. */
function TaskLinks({ links }: { links: TaskLink[] }): React.JSX.Element | null {
  if (links.length === 0) return null
  return (
    <div className="grid justify-items-start gap-[var(--space-1)]" data-testid="task-links">
      {links.map((link) => {
        const label = `${LINK_PROVIDER_LABEL[link.provider] ?? link.provider} · ${link.external_id}`
        const url = link.url
        return (
          <Chip
            key={`${link.provider}:${link.external_id}`}
            variant="compound"
            label={label}
            onClick={url ? () => void openExternal(url) : undefined}
          />
        )
      })}
    </div>
  )
}

/** Remembers the last Start so a not-ready refusal can repeat it with `force`. */
function useStartAnyway(onStart: TaskDetailProps['onStart']): {
  start: (id: number, agent: AgentKind, workspace?: string | null) => void
  force: () => void
} {
  const last = useRef<{ id: number; agent: AgentKind; workspace?: string | null } | null>(null)
  return {
    start: (id, agent, workspace) => {
      last.current = { id, agent, workspace }
      onStart(id, agent, workspace)
    },
    force: () => {
      if (last.current) onStart(last.current.id, last.current.agent, last.current.workspace, true)
    }
  }
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

function CopyKeyButton({ taskKey }: { taskKey: string }): React.JSX.Element {
  return (
    <Tooltip label="Copy task key" className="inline-flex">
      <TaskIconButton
        glyph={IconCopy}
        aria-label="Copy task key"
        data-testid="task-copy-key"
        onClick={() => void navigator.clipboard?.writeText(taskKey).catch(() => {})}
      />
    </Tooltip>
  )
}

function RefusalBanner({
  refusal,
  taskId,
  onReload,
  onStartAnyway
}: {
  refusal: TaskRefusal
  taskId: number
  onReload: (id: number) => void
  onStartAnyway: () => void
}): React.JSX.Element {
  if (refusal.kind === 'not_ready') {
    return (
      <Notice tone="warn" data-testid="task-not-ready-banner" action={{ label: 'Start anyway', onClick: onStartAnyway }}>
        {refusal.message}
      </Notice>
    )
  }
  if (refusal.kind === 'conflict') {
    return (
      <TaskBanner data-testid="task-conflict-banner">
        <Icon glyph={IconAlertTriangle} role="small" />
        <TaskBannerMessage>
          This task changed elsewhere
          <TaskBannerDetail>{refusal.message}</TaskBannerDetail>
        </TaskBannerMessage>
        <TaskButton tone="secondary" density="form" onClick={() => onReload(taskId)}>
          Reload
        </TaskButton>
      </TaskBanner>
    )
  }
  return (
    <TaskBanner tone="error" data-testid="task-refusal">
      <Icon glyph={IconAlertTriangle} role="small" />
      <TaskBannerMessage>{refusal.message}</TaskBannerMessage>
    </TaskBanner>
  )
}

function AcceptanceList({
  items,
  readOnly,
  presentation,
  onCheck
}: {
  items: TaskAcceptanceItem[]
  readOnly: boolean
  presentation: 'side' | 'drawer'
  onCheck: (itemId: number, checked: boolean) => void
}): React.JSX.Element {
  if (items.length === 0) return <TaskBody>No acceptance items.</TaskBody>
  const rows = items.map((item) => (
        <Tooltip key={item.id} label={readOnly ? READ_ONLY_REASON : undefined} className="flex">
          {presentation === 'drawer' ? <TaskAcceptanceRow
            testId={`task-acceptance-${item.id}`}
            checked={item.checked_at_ms != null}
            text={item.text}
            by={item.checked_by ? actorLabel(item.checked_by) : null}
            disabled={readOnly}
            onToggle={() => onCheck(item.id, item.checked_at_ms == null)}
          /> : <TaskCheckButton
            role="checkbox"
            aria-checked={item.checked_at_ms != null}
            disabled={readOnly}
            data-testid={`task-acceptance-${item.id}`}
            checked={item.checked_at_ms != null}
            mark={<Icon glyph={IconCheck} role="small" />}
            text={item.text}
            by={item.checked_by ? actorLabel(item.checked_by) : null}
            onClick={() => onCheck(item.id, item.checked_at_ms == null)}
          />}
        </Tooltip>
  ))
  return presentation === 'drawer' ? <div>{rows}</div> : <TaskBody column>{rows}</TaskBody>
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
  pane_working: <TaskDot tone="working" inset />,
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
  if (entries.length === 0) return <TaskBody>No activity yet.</TaskBody>
  return (
    <>
      {entries.map((entry) => (
        <TaskActivityRow key={entry.key} data-testid="task-activity">
          <TaskActivityIcon>{entry.icon}</TaskActivityIcon>
          <span>
            <TaskActivityActor>{actorLabel(entry.actor)}</TaskActivityActor> {entry.verb}
            {entry.detail && <span> {entry.detail}</span>}
            {entry.system && <TaskSystemMark size="system">{entry.system}</TaskSystemMark>}
            {entry.comment && <TaskActivityBubble>{entry.comment}</TaskActivityBubble>}
          </span>
          <TaskActivityTime>{formatAge(entry.at, now)}</TaskActivityTime>
        </TaskActivityRow>
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
    <TaskCommentBox>
      <TaskCommentField
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
        <TaskButton
          tone="secondary"
          density="composer"
          data-testid="task-comment-submit"
          disabled={readOnly || body.trim() === ''}
          onClick={submit}
        >
          Comment
        </TaskButton>
      </Tooltip>
    </TaskCommentBox>
  )
}

const STATUS_OPTIONS: SelectOption[] = STATUS_ORDER.map((status) => ({
  value: status,
  label: STATUS_LABEL[status]
}))

const PRIORITY_OPTIONS: SelectOption[] = (['urgent', 'high', 'medium', 'low', 'none'] as TaskPriority[]).map(
  (priority) => ({ value: priority, label: PRIORITY_LABEL[priority] })
)

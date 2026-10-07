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
import type { HoustonClient } from '../../houston/client'
import { isPullRequestUrl, linkIsPullRequest, sendTaskWire, type TaskTrackerLink } from '../../houston/taskDomain'
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
import { TextInput } from '../ui/TextInput'
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
import { TaskWorkflowPanel } from './TaskWorkflowPanel'
import {
  Button,
  Chip,
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
  Card,
  Inline,
  InlineLink,
  Text,
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
  onStart: (id: number, agent: AgentKind, workspace?: string | null) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
  onOpenSession: (sessionId: number) => void
  onReview: (session: SessionInfo) => void
  presentation?: 'side' | 'drawer'
  client?: HoustonClient | null
  onStartRequested?: (taskId: number, workspace: string) => void
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
  const [trackerLinks, setTrackerLinks] = useState<TaskTrackerLink[]>([])

  useEffect(() => {
    setTrackerLinks([])
    if (!props.client) return
    const off = props.client.subscribeAll((message) => {
      if (message.type === 'task_tracker_links' && message.task_id === task.id) setTrackerLinks(message.links)
      if (message.type === 'task_tracker_conflict_resolved' && message.task_id === task.id) {
        setTrackerLinks((current) => current.map((link) => link.provider === message.link.provider && link.external_id === message.link.external_id ? message.link : link))
      }
    })
    sendTaskWire(props.client, { type: 'task_tracker_links_get', task_id: task.id })
    return off
  }, [props.client, task.id])

  if (drawer) return <TaskDetailDrawer props={props} taskTitle={title} trackerLinks={trackerLinks} />

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
      {refusal && refusal.id === task.id && <RefusalBanner refusal={refusal} onReload={props.onReload} taskId={task.id} />}
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
          {reviewer !== null && (
            <TaskProp data-testid="task-reviewer-prop">
              <TaskPropKey>Reviewer</TaskPropKey>
              <TaskAgentIcon agent={reviewer} />
              {taskAgentLabel(reviewer)}
            </TaskProp>
          )}
        </TaskPropRow>
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

        {props.client && <TaskWorkflowPanel client={props.client} detail={detail} onOpenSession={props.onOpenSession} onStartRequested={props.onStartRequested} />}

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
        <TaskSectionLabel
          heading="Acceptance"
          trailing={acceptanceText(detail.acceptance.filter((item) => item.checked_at_ms != null).length, detail.acceptance.length)}
        />
        <TaskTrackerLinks client={props.client} taskId={task.id} sourceUrl={task.ref_url ?? null} links={trackerLinks} />
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

function TaskTrackerLinks({ client, taskId, sourceUrl, links }: { client?: Pick<HoustonClient, 'send'> | null; taskId: number; sourceUrl: string | null; links: TaskTrackerLink[] }): React.JSX.Element | null {
  if (!client && !sourceUrl) return null
  return <section className="grid gap-[var(--space-2)]" aria-label="Task tracker links">
    <TaskSectionLabel heading="Tracker links" />
    {sourceUrl && !links.some((link) => link.url === sourceUrl) && <Card padding="sm"><InlineLink href={sourceUrl}>Task source</InlineLink></Card>}
    {links.length === 0 && !sourceUrl ? <TaskBody>No tracker links.</TaskBody> : links.map((link) => <Card key={`${link.provider}:${link.external_id}`} padding="sm" className="grid gap-[var(--space-2)]">
      <InlineLink href={link.url}>{linkIsPullRequest(link) ? 'Pull request' : 'Source'} · {link.external_id}</InlineLink>
      <TaskBody>{link.sync_state.state === 'error' ? `Sync error: ${link.sync_state.message}` : link.sync_state.state === 'diverged' ? 'Tracker data diverged' : link.sync_state.state === 'pending' ? 'Sync pending' : 'In sync'}</TaskBody>
      {link.snapshot.project && <TaskBody>Imported project context — unverified. {link.snapshot.project.title}: {link.snapshot.project.description}</TaskBody>}
      {!link.snapshot.project && link.snapshot.project_external_id && <TaskBody>External project ID {link.snapshot.project_external_id} has not been matched to a local project.</TaskBody>}
      {client && link.snapshot.conflicts.map((conflict) => <TrackerConflict key={conflict.field} client={client} taskId={taskId} link={link} field={conflict.field} base={conflict.base} local={conflict.local} remote={conflict.remote} />)}
      {link.sync_state.state === 'diverged' && link.snapshot.conflicts.length === 0 && <TaskBody>Tracker data diverged; no field conflict needs resolution.</TaskBody>}
      {link.sync_state.state === 'error' && <TaskBody>{link.sync_state.message}</TaskBody>}
    </Card>)}
  </section>
}

function TrackerConflict({ client, taskId, link, field, base, local, remote }: { client: Pick<HoustonClient, 'send'>; taskId: number; link: TaskTrackerLink; field: string; base: string; local: string; remote: string }): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const resolve = (resolution: { kind: 'local' | 'remote' } | { kind: 'custom'; value: string }): void => sendTaskWire(client, {
    type: 'task_tracker_conflict_resolve', task_id: taskId, provider: link.provider,
    external_id: link.external_id, field, expected_revision: link.snapshot.revision, resolution
  })
  return <Card tone="inset" padding="sm" className="grid gap-[var(--space-1)]">
    <Text weight="semibold">{field} differs between Houston and the tracker</Text>
    <Text>Previous shared value: {base || '—'}</Text><Text>Houston value: {local || '—'}</Text><Text>Tracker value: {remote || '—'}</Text>
    <Inline wrap gap="small"><Button variant="secondary" onClick={() => resolve({ kind: 'local' })}>Keep Houston value</Button><Button variant="secondary" onClick={() => resolve({ kind: 'remote' })}>Use tracker value</Button></Inline>
    <div className="flex gap-[var(--space-2)]"><TextInput aria-label={`Custom ${field} value`} value={custom} onChange={(event) => setCustom(event.target.value)} /><Button variant="secondary" disabled={!custom.trim()} onClick={() => resolve({ kind: 'custom', value: custom })}>Use custom value</Button></div>
  </Card>
}

function TaskDetailDrawer({ props, taskTitle, trackerLinks }: { props: TaskDetailProps; taskTitle: string; trackerLinks: TaskTrackerLink[] }): React.JSX.Element {
  const { detail, now } = props
  const { task } = detail
  const latestRun = detail.runs[0] ?? null
  const archived = task.archived_at_ms != null
  const startable = !archived && (task.status === 'backlog' || task.status === 'todo')
  const review = taskReviewOutcome(detail.runs, detail.comments)
  const checked = detail.acceptance.filter((item) => item.checked_at_ms != null).length

  return <TaskDetailFrame>
    {props.refusal && props.refusal.id === task.id && <RefusalBanner refusal={props.refusal} onReload={props.onReload} taskId={task.id} />}
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
      pullRequestUrl={latestRun?.pr_url && isPullRequestUrl(latestRun.pr_url) ? latestRun.pr_url : null}
    />}
    {!latestRun && startable && <TaskStartCard task={task} settings={props.startSettings} workspaceOptions={props.workspaceOptions} readOnly={false} onStart={props.onStart} />}
    {props.client && <TaskWorkflowPanel client={props.client} detail={detail} onOpenSession={props.onOpenSession} onStartRequested={props.onStartRequested} />}
    <div className="grid gap-[var(--space-2)]">
        <TaskTrackerLinks client={props.client} taskId={task.id} sourceUrl={task.ref_url ?? null} links={trackerLinks} />
      <TaskSectionLabel heading="Acceptance" trailing={`${checked}/${detail.acceptance.length}`} />
      <TaskDrawerCard><AcceptanceList
        items={detail.acceptance}
        readOnly={false}
        presentation="drawer"
        onCheck={(item, isChecked) => props.onCheck(task.id, item, isChecked)}
      /></TaskDrawerCard>
      {task.origin?.kind === 'harness_finding' && <TaskDrawerOrigin><Chip variant="compound" label={`From Harness finding · ${task.origin.key}`} /></TaskDrawerOrigin>}
    </div>
  </TaskDetailFrame>
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
  onReload
}: {
  refusal: TaskRefusal
  taskId: number
  onReload: (id: number) => void
}): React.JSX.Element {
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

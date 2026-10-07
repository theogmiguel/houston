import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo } from '../../houston/client'
import type { TaskAcceptanceItem } from '../../houston/generated/TaskAcceptanceItem'
import type { TaskComment } from '../../houston/generated/TaskComment'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunAction } from '../../houston/generated/TaskRunAction'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import type { TaskDetailData, TaskRefusal, TaskStartSettings } from '../../houston/useTasks'
import { Icon } from '../ui/Icon'
import { MarkdownPreview } from '../MarkdownPreview'
import {
  IconAlertTriangle,
  IconArchive,
  IconCheck,
  IconClose,
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
import type { SelectOption } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'
import {
  actorLabel,
  formatAge,
  historyLine,
  READ_ONLY_REASON,
  taskReviewOutcome
} from './format'
import { TaskExecutionCard, TaskStartCard } from './TaskExecution'
import { TaskMenu } from './TaskMenu'
import {
  Button,
  Chip,
  TaskAcceptanceRow,
  TaskActivityActor,
  TaskActivityBubble,
  TaskActivityIcon,
  TaskActivityRow,
  TaskActivityTime,
  TaskBanner,
  TaskBannerDetail,
  TaskBannerMessage,
  TaskBody,
  TaskButton,
  TaskCommentBox,
  TaskCommentField,
  TaskDetailFrame,
  TaskDot,
  TaskDrawerCard,
  TaskDrawerHeader,
  TaskDrawerOrigin,
  TaskSectionLabel,
  TaskSystemMark
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
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const { detail } = props
  const { task } = detail
  const [description, setDescription] = useServerDraft(task.description, task.revision)
  return <TaskDetailDrawer props={props} description={description} setDescription={setDescription} />
}

function TaskDetailDrawer({ props, description, setDescription }: { props: TaskDetailProps; description: string; setDescription: (value: string) => void }): React.JSX.Element {
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
      heading={task.title}
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
      pullRequestUrl={task.ref_url ?? null}
    />}
    {!latestRun && startable && <TaskStartCard task={task} settings={props.startSettings} workspaceOptions={props.workspaceOptions} readOnly={false} onStart={props.onStart} />}
    <TaskDescriptionSection task={task} description={description} setDescription={setDescription} onSave={props.onSave} />
    <div className="grid gap-[var(--space-2)]">
      <TaskSectionLabel heading="Acceptance" trailing={`${checked}/${detail.acceptance.length}`} />
      <TaskDrawerCard><AcceptanceList
        items={detail.acceptance}
        readOnly={false}
        onCheck={(item, isChecked) => props.onCheck(task.id, item, isChecked)}
      /></TaskDrawerCard>
      {task.origin?.kind === 'harness_finding' && <TaskDrawerOrigin><Chip variant="compound" label={`From Harness finding · ${task.origin.key}`} /></TaskDrawerOrigin>}
    </div>
    <section className="grid gap-[var(--space-2)]">
      <TaskSectionLabel heading="Activity" />
      <TaskDrawerCard>
        <div className="grid gap-[var(--space-2)] p-[var(--space-3)]">
          <ActivityFeed history={detail.history} comments={detail.comments} runs={detail.runs} now={now} />
          <CommentComposer readOnly={false} onSubmit={(body) => props.onComment(task.id, body)} />
        </div>
      </TaskDrawerCard>
    </section>
  </TaskDetailFrame>
}

function TaskDescriptionSection({ task, description, setDescription, onSave }: {
  task: TaskDetailProps['detail']['task']
  description: string
  setDescription: (value: string) => void
  onSave: TaskDetailProps['onSave']
}): React.JSX.Element {
  const [editingDescription, setEditingDescription] = useState(false)
  const [expandedDescription, setExpandedDescription] = useState(false)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const cancelDescriptionSave = useRef(false)
  const canExpandDescription = description.split('\n').length > 8

  useEffect(() => {
    setEditingDescription(false)
    setExpandedDescription(false)
  }, [task.id])

  useEffect(() => {
    if (!editingDescription || !descriptionField.current) return
    descriptionField.current.focus()
    descriptionField.current.style.height = 'auto'
    descriptionField.current.style.height = `${descriptionField.current.scrollHeight}px`
  }, [description, editingDescription])

  const saveDescription = (): void => {
    setEditingDescription(false)
    if (cancelDescriptionSave.current) {
      cancelDescriptionSave.current = false
      return
    }
    if (description !== task.description) onSave(task.id, task.revision, { description })
  }

  return (
      <section className="grid gap-[var(--space-1)]" data-testid="task-description">
        <div className="group flex items-center">
          <div className="flex-1"><TaskSectionLabel heading="Description" /></div>
          <Tooltip label="Edit description">
            <Button variant="icon" icon={IconPencil} aria-label="Edit description" className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setEditingDescription(true)} />
          </Tooltip>
        </div>
        <TaskDrawerCard>
          {editingDescription ? <textarea
            ref={descriptionField}
            aria-label="Task description"
            data-testid="task-description-editor"
            className="block w-full resize-none border-0 bg-transparent p-[var(--space-3)] text-[var(--text-primary)] outline-none"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={saveDescription}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                cancelDescriptionSave.current = true
                setDescription(task.description)
                setEditingDescription(false)
                event.currentTarget.blur()
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
          /> : description.trim() === '' ? <div className="flex items-center justify-between gap-[var(--space-2)] p-[var(--space-3)]">
            <span className="text-[var(--text-muted)]">No description</span>
            <Button variant="ghost" size="sm" onClick={() => setEditingDescription(true)}>Add description</Button>
          </div> : <>
            <div className="relative grid transition-[grid-template-rows] duration-150 ease-out" style={{ gridTemplateRows: canExpandDescription && !expandedDescription ? '12.4em' : '1fr' }}>
              <div className={`min-h-0 overflow-hidden p-[var(--space-3)] ${canExpandDescription && !expandedDescription ? 'line-clamp-[8]' : ''}`} onDoubleClick={() => setEditingDescription(true)}>
                <MarkdownPreview source={description} variant="chat" />
              </div>
              {canExpandDescription && !expandedDescription && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--card-bg)] to-transparent" />}
            </div>
            {canExpandDescription && <Button variant="ghost" size="sm" className="mx-[var(--space-2)] mb-[var(--space-2)]" onClick={() => setExpandedDescription((value) => !value)}>{expandedDescription ? 'Show less' : 'Show more'}</Button>}
          </>}
        </TaskDrawerCard>
      </section>
  )
}

function useServerDraft(server: string, revision: number): [string, (value: string) => void] {
  const [draft, setDraft] = useState(server)
  useEffect(() => {
    setDraft(server)
  }, [server, revision])
  return [draft, setDraft]
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
  onCheck
}: {
  items: TaskAcceptanceItem[]
  readOnly: boolean
  onCheck: (itemId: number, checked: boolean) => void
}): React.JSX.Element {
  if (items.length === 0) return <TaskBody>No acceptance items.</TaskBody>
  const rows = items.map((item) => (
        <Tooltip key={item.id} label={readOnly ? READ_ONLY_REASON : undefined} className="flex">
          <TaskAcceptanceRow
            testId={`task-acceptance-${item.id}`}
            checked={item.checked_at_ms != null}
            text={item.text}
            by={item.checked_by ? actorLabel(item.checked_by) : null}
            disabled={readOnly}
            onToggle={() => onCheck(item.id, item.checked_at_ms == null)}
          />
        </Tooltip>
  ))
  return <div>{rows}</div>
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

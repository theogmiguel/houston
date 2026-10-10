import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo } from '../../houston/client'
import type { TaskAcceptanceItem } from '../../houston/generated/TaskAcceptanceItem'
import type { TaskComment } from '../../houston/generated/TaskComment'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPatch } from '../../houston/generated/TaskPatch'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunAction } from '../../houston/generated/TaskRunAction'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import type { TaskDetailData, TaskRefusal, TaskStartSettings } from '../../houston/useTasks'
import type { HoustonClient } from '../../houston/client'
import { isPullRequestUrl, linkIsPullRequest, sendTaskWire, type TaskProject, type TaskTrackerLink } from '../../houston/taskDomain'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { MarkdownPreview } from '../MarkdownPreview'
import { ShellElement, ShellTaskDescriptionEditButton, ShellTaskDescriptionTextarea } from '../ui/ShellPrimitives'
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
import { type SelectOption } from '../ui/Select'
import { TextInput } from '../ui/TextInput'
import { Tooltip } from '../ui/Tooltip'
import {
  actorLabel,
  formatAge,
  historyLine,
  intakeLabel,
  READ_ONLY_REASON,
  taskReviewOutcome
} from './format'
import { TaskExecutionCard, TaskStartCard } from './TaskExecution'
import { ACCEPTANCE_ITEMS_PER_TASK } from '../../houston/generated/DEFAULTS'
import { TaskMenu } from './TaskMenu'
import { TaskQuestionCard } from './TaskQuestionCard'
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
  TaskBanner,
  TaskBannerDetail,
  TaskBannerMessage,
  TaskBody,
  TaskButton,
  TaskCommentBox,
  TaskCommentField,
  TaskDetailFrame,
  TaskDescriptionPreview,
  TaskDot,
  TaskDrawerCard,
  TaskDrawerHeader,
  TaskDrawerOrigin,
  TaskFieldInput,
  TaskIconButton,
  Card,
  Inline,
  InlineLink,
  Text,
  TaskSectionLabel,
  TaskSystemMark
} from '../ui'

export interface TaskDetailProps {
  detail: TaskDetailData
  /** The list's summary of this task: it carries the intake state and the agent's open question. */
  summary?: TaskSummary | null
  access: TasksAccess | null
  refusal: TaskRefusal | null
  now: number
  parentOptions: SelectOption[]
  workspaceOptions?: SelectOption[]
  sessions: ReadonlyMap<number, SessionInfo>
  startSettings: TaskStartSettings | null
  /** Absent when the detail sits inline beside its list, which owns navigation back. */
  onBack?: () => void
  primaryAction?: ReactNode
  onReload: (id: number) => void
  onSave: (id: number, expectedRevision: number, patch: TaskPatch) => void
  onCheck: (id: number, item: number, checked: boolean) => void
  onComment: (id: number, body: string) => void
  onArchive: (id: number, archived: boolean, expectedRevision: number) => void
  onStart: (id: number, agent: AgentKind, workspace?: string | null) => void
  onRunControl: (runId: number, action: TaskRunAction) => void
  onOpenSession: (sessionId: number) => void
  onReview: (session: SessionInfo) => void
  client?: Pick<HoustonClient, 'subscribeAll' | 'taskSnapshot' | 'taskSave' | 'send'> | null
  onStartRequested?: (taskId: number, workspace: string) => void
}

export function TaskDetail(props: TaskDetailProps): React.JSX.Element {
  const { detail } = props
  const { task } = detail
  const [trackerLinks, setTrackerLinks] = useState<TaskTrackerLink[]>([])
  const [trackerProject, setTrackerProject] = useState<TaskProject | null>(null)
  const trackerProjectId = useRef<number | null>(null)
  const trackerProjectMinRevision = useRef(0)

  useEffect(() => {
    setTrackerLinks([])
    setTrackerProject(null)
    trackerProjectId.current = null
    trackerProjectMinRevision.current = 0
    const client = props.client
    if (!client) return
    const off = client.subscribeAll((message) => {
      if (message.type === 'task_tracker_links' && message.task_id === task.id) setTrackerLinks(message.links)
      if (message.type === 'task_domain_state' && message.domain.task_id === task.id) {
        trackerProjectId.current = message.domain.project_id ?? null
        trackerProjectMinRevision.current = 0
        setTrackerProject(null)
        if (message.domain.project_id != null) sendTaskWire(client, { type: 'task_project_get', id: message.domain.project_id })
      }
      if (message.type === 'task_project_state' && message.project?.id === trackerProjectId.current && message.project.revision >= trackerProjectMinRevision.current) setTrackerProject(message.project)
      if (message.type === 'task_project_changed' && message.id === trackerProjectId.current && message.workspace === task.workspace) {
        trackerProjectMinRevision.current = message.revision
        setTrackerProject(null)
        sendTaskWire(client, { type: 'task_project_get', id: message.id })
      }
      if (message.type === 'task_tracker_conflict_resolved' && message.task_id === task.id) {
        setTrackerLinks((current) => current.map((link) => link.provider === message.link.provider && link.external_id === message.link.external_id ? message.link : link))
      }
    })
    sendTaskWire(client, { type: 'task_tracker_links_get', task_id: task.id })
    sendTaskWire(client, { type: 'task_domain_get', id: task.id })
    return off
  }, [props.client, task.id, task.workspace])

  return <TaskDetailDrawer props={props} trackerLinks={trackerLinks} trackerProject={trackerProject} />
}


function TaskTrackerLinks({ client, taskId, taskRevision, projectRevision, sourceUrl, links }: { client?: Pick<HoustonClient, 'send'> | null; taskId: number; taskRevision: number; projectRevision: number | null; sourceUrl: string | null; links: TaskTrackerLink[] }): React.JSX.Element | null {
  if (!client && !sourceUrl) return null
  return <section className="grid gap-[var(--space-2)]" aria-label="Task tracker links">
    <TaskSectionLabel heading="Tracker links" />
    {sourceUrl && !links.some((link) => link.url === sourceUrl) && <Card padding="sm"><InlineLink href={sourceUrl}>Task source</InlineLink></Card>}
    {links.length === 0 && !sourceUrl ? <TaskBody>No tracker links.</TaskBody> : links.map((link) => <Card key={`${link.provider}:${link.external_id}`} padding="sm" className="grid gap-[var(--space-2)]">
      <InlineLink href={link.url}>{linkIsPullRequest(link) ? 'Pull request' : 'Source'} · {link.external_id}</InlineLink>
      <TaskBody>{link.sync_state.state === 'error' ? `Sync error: ${link.sync_state.message}` : link.sync_state.state === 'diverged' ? 'Tracker data diverged' : link.sync_state.state === 'pending' ? 'Sync pending' : 'In sync'}</TaskBody>
      {link.snapshot.project && <TaskBody>Imported project context — unverified. {link.snapshot.project.title}: {link.snapshot.project.description}</TaskBody>}
      {!link.snapshot.project && link.snapshot.project_external_id && <TaskBody>External project ID {link.snapshot.project_external_id} has not been matched to a local project.</TaskBody>}
      {client && link.snapshot.conflicts.map((conflict) => <TrackerConflict key={conflict.field} client={client} taskId={taskId} taskRevision={taskRevision} projectRevision={projectRevision} link={link} field={conflict.field} base={conflict.base} local={conflict.local} remote={conflict.remote} />)}
      {link.sync_state.state === 'diverged' && link.snapshot.conflicts.length === 0 && <TaskBody>Tracker data diverged; no field conflict needs resolution.</TaskBody>}
      {link.sync_state.state === 'error' && <TaskBody>{link.sync_state.message}</TaskBody>}
    </Card>)}
  </section>
}

function TrackerConflict({ client, taskId, taskRevision, projectRevision, link, field, base, local, remote }: { client: Pick<HoustonClient, 'send'>; taskId: number; taskRevision: number; projectRevision: number | null; link: TaskTrackerLink; field: string; base: string; local: string; remote: string }): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const projectField = field.startsWith('project.')
  const projectKnown = projectRevision != null
  const resolve = (resolution: { kind: 'local' | 'remote' } | { kind: 'custom'; value: string }): void => sendTaskWire(client, {
    type: 'task_tracker_conflict_resolve', task_id: taskId, provider: link.provider,
    external_id: link.external_id, field, expected_revision: link.snapshot.revision,
    expected_task_revision: taskRevision, expected_project_revision: projectField ? projectRevision : null, resolution
  })
  return <Card tone="inset" padding="sm" className="grid gap-[var(--space-1)]">
    <Text weight="semibold">{field} differs between Houston and the tracker</Text>
    <Text>Previous shared value: {base || '—'}</Text><Text>Houston value: {local || '—'}</Text><Text>Tracker value: {remote || '—'}</Text>
    {projectField && !projectKnown && <Text size="small" tone="muted">Load the assigned Project before resolving this field.</Text>}
    <Inline wrap gap="small"><Button variant="secondary" disabled={projectField && !projectKnown} onClick={() => resolve({ kind: 'local' })}>Keep Houston value</Button><Button variant="secondary" disabled={projectField && !projectKnown} onClick={() => resolve({ kind: 'remote' })}>Use tracker value</Button></Inline>
    <div className="flex gap-[var(--space-2)]"><TextInput aria-label={`Custom ${field} value`} value={custom} onChange={(event) => setCustom(event.target.value)} /><Button variant="secondary" disabled={!custom.trim() || projectField && !projectKnown} onClick={() => resolve({ kind: 'custom', value: custom })}>Use custom value</Button></div>
  </Card>
}

function TaskDetailDrawer({ props, trackerLinks, trackerProject }: { props: TaskDetailProps; trackerLinks: TaskTrackerLink[]; trackerProject: TaskProject | null }): React.JSX.Element {
  const { detail } = props
  const { task } = detail
  const latestRun = detail.runs[0] ?? null
  const archived = task.archived_at_ms != null
  const finished = task.status === 'done' || task.status === 'canceled'
  const [confirmCancel, setConfirmCancel] = useState(false)
  const setStatus = (status: TaskStatus): void => props.onSave(task.id, task.revision, { status })

  return <TaskDetailFrame>
    {props.refusal && props.refusal.id === task.id && <RefusalBanner refusal={props.refusal} onReload={props.onReload} taskId={task.id} />}
    <TaskDrawerHeader
      taskKey={task.key}
      workspace={task.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No workspace'}
      heading={task.title}
      status={task.status}
      actions={<>
        {props.primaryAction}
        {finished
          ? <Button variant="secondary" size="sm" data-testid="task-reopen" onClick={() => setStatus('todo')}>Reopen</Button>
          : <Button variant="secondary" size="sm" data-testid="task-mark-done" onClick={() => setStatus('done')}>Mark done</Button>}
        {props.onBack && <Button variant="icon" icon={IconClose} aria-label="Close task details" onClick={props.onBack} />}
        <TaskMenu
          label="Task actions"
          icon={IconEllipsis}
          testId="task-detail-menu"
          sections={[{ items: [
            ...(latestRun?.session_id != null ? [{ id: 'task-open-session', label: 'Open session', onSelect: () => props.onOpenSession(latestRun.session_id!) }] : []),
            { id: 'task-copy-key', label: 'Copy task key', onSelect: () => void navigator.clipboard?.writeText(task.key).catch(() => {}) },
            ...(finished ? [] : [{ id: 'task-cancel', label: 'Cancel task', onSelect: () => setConfirmCancel(true) }]),
            { id: 'task-archive', label: archived ? 'Restore task' : 'Archive task', onSelect: () => props.onArchive(task.id, !archived, task.revision) }
          ] }]}
        />
      </>}
    />
    <TaskDrawerContents props={props} trackerLinks={trackerLinks} trackerProject={trackerProject} />
    {confirmCancel && <ConfirmDialog
      title={`Cancel ${task.key}?`}
      confirmLabel="Cancel task"
      onCancel={() => setConfirmCancel(false)}
      onConfirm={() => {
        setConfirmCancel(false)
        setStatus('canceled')
      }}
    >
      <Text>The task moves to Canceled. Reopen returns it to Todo.</Text>
    </ConfirmDialog>}
  </TaskDetailFrame>
}

function TaskDrawerContents({ props, trackerLinks, trackerProject }: {
  props: TaskDetailProps
  trackerLinks: TaskTrackerLink[]
  trackerProject: TaskProject | null
}): React.JSX.Element {
  const { detail, now } = props
  const { task } = detail
  const latestRun = detail.runs[0] ?? null
  const startable = task.archived_at_ms == null && (task.status === 'backlog' || task.status === 'todo')
  const review = taskReviewOutcome(detail.runs, detail.comments)
  const checked = detail.acceptance.filter((item) => item.checked_at_ms != null).length
  const [description, setDescription] = useServerDraft(task.description, task.revision)
  const intake = props.summary?.id === task.id ? intakeLabel(props.summary) : null
  const question = props.summary?.id === task.id ? props.summary.open_question ?? null : null

  return <>
    {intake && <TaskDrawerOrigin><span data-testid="task-intake-chip"><Chip variant="state" tone="info" label={intake} /></span></TaskDrawerOrigin>}
    {question && <TaskQuestionCard question={question} client={props.client ?? null} refusal={props.refusal} onOpenSession={props.onOpenSession} />}
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
    <TaskDescriptionSection task={task} description={description} setDescription={setDescription} onSave={props.onSave} />
    <div className="grid gap-[var(--space-2)]">
      <TaskTrackerLinks client={props.client} taskId={task.id} taskRevision={task.revision} projectRevision={trackerProject?.revision ?? null} sourceUrl={task.ref_url ?? null} links={trackerLinks} />
      <AcceptanceSection
        taskId={task.id}
        revision={task.revision}
        items={detail.acceptance}
        checked={checked}
        onCheck={(item, isChecked) => props.onCheck(task.id, item, isChecked)}
        onSave={props.onSave}
      />
      {task.origin?.kind === 'harness_finding' && <TaskDrawerOrigin><Chip variant="compound" label={`From Harness finding · ${task.origin.key}`} /></TaskDrawerOrigin>}
    </div>
    <section className="grid gap-[var(--space-2)]">
      <TaskSectionLabel heading="Activity" />
      <TaskDrawerCard>
        <ShellElement as="div" shellRole="task-activity-content">
          <ActivityFeed history={detail.history} comments={detail.comments} runs={detail.runs} now={now} />
          <CommentComposer readOnly={false} onSubmit={(body) => props.onComment(task.id, body)} />
        </ShellElement>
      </TaskDrawerCard>
    </section>
  </>
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
        <ShellElement as="div" shellRole="task-description-heading">
          <div className="flex-1"><TaskSectionLabel heading="Description" /></div>
          <Tooltip label="Edit description">
            <ShellTaskDescriptionEditButton onClick={() => setEditingDescription(true)} />
          </Tooltip>
        </ShellElement>
        <TaskDrawerCard>
          {editingDescription ? <ShellTaskDescriptionTextarea
            ref={descriptionField}
            aria-label="Task description"
            data-testid="task-description-editor"
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
          /> : description.trim() === '' ? <ShellElement as="div" shellRole="task-description-empty">
            <ShellElement as="span" shellRole="task-description-empty-label">No description</ShellElement>
            <Button variant="ghost" size="sm" onClick={() => setEditingDescription(true)}>Add description</Button>
          </ShellElement> : <TaskDescriptionPreview
            expanded={expandedDescription}
            canExpand={canExpandDescription}
            onToggle={() => setExpandedDescription((value) => !value)}
            onDoubleClick={() => setEditingDescription(true)}
          >
            <MarkdownPreview source={description} variant="chat" />
          </TaskDescriptionPreview>}
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

// The daemon's rule (task_proof.rs acceptance_command): the first backtick
// pair, trimmed of spaces, holds a command.
function isExecutableItem(text: string): boolean {
  const start = text.indexOf('`')
  const end = start < 0 ? -1 : text.indexOf('`', start + 1)
  return end > start && text.slice(start + 1, end).replace(/^ +| +$/g, '') !== ''
}

/// Acceptance with in-place editing. A save replaces the list through
/// `task_save`; the daemon keeps the tick of each item whose text is unchanged.
function AcceptanceSection({ taskId, revision, items, checked, onCheck, onSave }: {
  taskId: number
  revision: number
  items: TaskAcceptanceItem[]
  checked: number
  onCheck: (itemId: number, checked: boolean) => void
  onSave: TaskDetailProps['onSave']
}): React.JSX.Element {
  // The revision the draft was read at, so a change made meanwhile comes back as a conflict.
  const [draft, setDraft] = useState<{ items: string[]; revision: number } | null>(null)
  const [addedItem, setAddedItem] = useState<number | null>(null)
  useEffect(() => {
    setDraft(null)
  }, [taskId])
  const executable = items.filter((item) => isExecutableItem(item.text)).length
  const edit = (index: number, value: string): void => setDraft((current) => current && { ...current, items: current.items.map((item, i) => (i === index ? value : item)) })
  const save = (): void => {
    if (!draft) return
    onSave(taskId, draft.revision, { acceptance: draft.items.map((item) => item.trim()).filter((item) => item !== '') })
    setDraft(null)
  }

  return <section className="grid gap-[var(--space-2)]" aria-label="Acceptance" data-testid="task-acceptance">
    <div className="flex items-center gap-[var(--space-2)]">
      <div className="flex-1"><TaskSectionLabel heading="Acceptance" trailing={`${checked}/${items.length} · ${executable} executable`} /></div>
      {!draft && <Button variant="ghost" size="sm" data-testid="task-acceptance-edit" onClick={() => {
        setAddedItem(null)
        setDraft({ items: items.map((item) => item.text), revision })
      }}>Edit</Button>}
    </div>
    <TaskDrawerCard>
      {draft ? <div className="grid gap-[var(--space-2)]">
        {draft.items.map((item, index) => (
          <div key={index} className="flex items-center gap-[var(--space-2)]">
            <TaskFieldInput
              className="flex-1"
              autoFocus={index === addedItem}
              aria-label={`Acceptance item ${index + 1}`}
              value={item}
              onChange={(event) => edit(index, event.target.value)}
            />
            <TaskIconButton
              glyph={IconClose}
              aria-label={`Remove acceptance item ${index + 1}`}
              onClick={() => setDraft((current) => current && { ...current, items: current.items.filter((_, i) => i !== index) })}
            />
          </div>
        ))}
        <Text size="small" tone="muted">A command in backticks, such as `cargo test -p app`, makes an item executable. A task needs one to be ready; other items stay as criteria for you.</Text>
        <Inline wrap gap="small">
          <Tooltip label={draft.items.length >= ACCEPTANCE_ITEMS_PER_TASK ? `A task holds at most ${ACCEPTANCE_ITEMS_PER_TASK} acceptance items` : undefined} className="inline-flex">
            <Button
              variant="ghost"
              size="sm"
              icon={IconPlus}
              data-testid="task-acceptance-add"
              disabled={draft.items.length >= ACCEPTANCE_ITEMS_PER_TASK}
              onClick={() => {
                setAddedItem(draft.items.length)
                setDraft((current) => current && { ...current, items: [...current.items, ''] })
              }}
            >Add item</Button>
          </Tooltip>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
          <Button variant="primary" size="sm" data-testid="task-acceptance-save" onClick={save}>Save acceptance</Button>
        </Inline>
      </div> : <AcceptanceList items={items} readOnly={false} onCheck={onCheck} />}
    </TaskDrawerCard>
  </section>
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
        <div key={item.id} className="flex items-center gap-[var(--space-2)]">
          <Tooltip label={readOnly ? READ_ONLY_REASON : undefined} className="flex min-w-0 flex-1">
            <TaskAcceptanceRow
              testId={`task-acceptance-${item.id}`}
              checked={item.checked_at_ms != null}
              text={item.text}
              by={item.checked_by ? actorLabel(item.checked_by) : null}
              disabled={readOnly}
              onToggle={() => onCheck(item.id, item.checked_at_ms == null)}
            />
          </Tooltip>
          {isExecutableItem(item.text) && <span data-testid={`task-acceptance-executable-${item.id}`}><Chip variant="state" tone="info" label="Executable" /></span>}
        </div>
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

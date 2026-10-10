import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo, HoustonClient } from '../../houston/client'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { useTaskStartSettings, useTasks } from '../../houston/useTasks'
import { useTaskProjects } from '../../houston/useTaskProjects'
import type { TaskDomain, TaskProject } from '../../houston/taskDomain'
import { AnimOut } from '../ui/AnimOut'
import { PanelListHead, PanelTextInput } from '../ui/PanelControls'
import { Button, Chip, EmptyState, Inline, ListDetail, NavSurfaceFrame, PageFrame, PageHeader, Segmented, Select, StatusLabel, Text, type ListDetailItem } from '../ui'
import { IconChevronDown, IconChevronRight, IconFolderOpen, IconPlus, IconTasks } from '../icons'
import { TaskComposer } from '../tasks/TaskComposer'
import { TaskDetail } from '../tasks/TaskDetail'
import { TaskProjectsDialog } from '../tasks/TaskProjectsDialog'
import { FINISHED_GROUP_LABEL, formatAge, formatAgo, intakeLabel, queueActionOf, queueGroupOf, STATUS_LABEL, taskAgentLabel } from '../tasks/format'
import { filterTasks, isFinished, projectEntries, queueEntries, type TaskGrouping, type TaskListEntry } from '../tasks/taskListSections'
import { isPullRequestUrl } from '../../houston/taskDomain'
import { queueAgentLabel, questionFor, useInboxRows } from '../tasks/needsInput'
import type { InboxRow } from '../../houston/generated/InboxRow'

type TaskItem = ListDetailItem & { task: TaskSummary }

export function TasksSurface({
  client,
  workspace,
  workspaces,
  sessions,
  now,
  openTaskId,
  onOpenTaskHandled,
  compose,
  createDraft,
  onCreateHandled,
  onStartRequested,
  onOpenSession,
  onReview,
  onOpenExternal
}: {
  client: HoustonClient | null
  workspace: string
  workspaces: { path: string; name: string }[]
  sessions: ReadonlyMap<number, SessionInfo>
  now: number
  openTaskId?: number
  onOpenTaskHandled?: () => void
  compose?: boolean
  createDraft?: { title: string; description: string }
  onCreateHandled?: () => void
  onStartRequested: (taskId: number, workspace: string) => void
  onOpenSession: (id: number) => void
  onReview: (session: SessionInfo) => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const scope = workspace || 'all'
  const tasks = useTasks(client, workspace || null, scope)
  const { settings: startSettings } = useTaskStartSettings(client, tasks.detail?.task.workspace ?? workspace)
  const [create, setCreate] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [inboxRows, setInboxRows] = useState<InboxRow[]>([])
  const [grouping, setGrouping] = useState<TaskGrouping>('queue')
  const [projectFilter, setProjectFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [showFinished, setShowFinished] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const allTasks = useMemo(() => tasks.snapshot?.tasks ?? [], [tasks.snapshot])
  const inboxWorkspaces = useMemo(() => [...new Set([
    workspace,
    ...workspaces.map((item) => item.path),
    ...allTasks.map((task) => task.workspace ?? '')
  ].filter(Boolean))], [workspace, workspaces, allTasks])
  const projectWorkspaces = useMemo(() => workspace ? [workspace] : [...new Set(allTasks.map((task) => task.workspace).filter((path): path is string => !!path))], [workspace, allTasks])
  const projects = useTaskProjects(client, projectWorkspaces, tasks.snapshot ? allTasks : null)
  const parentOptions = useMemo(() => allTasks
    .filter((task) => task.archived_at_ms == null && task.id !== detailId)
    .map((task) => ({ value: String(task.id), label: `${task.key} — ${task.title}` })), [allTasks, detailId])
  const entries = useMemo(() => {
    const visible = filterTasks(allTasks, query, projectFilter, projects.domains)
    return grouping === 'queue' ? queueEntries(visible, showFinished) : projectEntries(visible, projects.projects ?? [], projects.domains, showFinished)
  }, [allTasks, query, projectFilter, grouping, showFinished, projects.domains, projects.projects])
  const finishedCount = useMemo(() => filterTasks(allTasks, query, projectFilter, projects.domains).filter(isFinished).length, [allTasks, query, projectFilter, projects.domains])
  const items: TaskItem[] = entries.map((entry) => ({
    id: String(entry.task.id),
    title: entry.task.title,
    sub: <TaskListMeta entry={entry} notes={grouping === 'project' ? projectNotes(entry.task, entry.delivery, projects.domains[entry.task.id]) : [metaOf(entry.task, now, sessions, inboxRows)]} />,
    section: entry.section,
    task: entry.task
  }))

  useEffect(() => {
    if (openTaskId === undefined) return
    setCreate(false)
    setQuery('')
    setProjectFilter('all')
    setShowFinished((shown) => shown || allTasks.some((task) => task.id === openTaskId && isFinished(task)))
    setDetailId(openTaskId)
    tasks.openTask(openTaskId)
    onOpenTaskHandled?.()
  }, [openTaskId, onOpenTaskHandled, tasks.openTask]) // eslint-disable-line react-hooks/exhaustive-deps -- reacts to a new request only, not to list changes
  useEffect(() => {
    if (!compose && !createDraft) return
    setDetailId(null)
    setCreate(true)
    onCreateHandled?.()
  }, [compose, createDraft, onCreateHandled])
  useInboxRows(client, inboxWorkspaces, setInboxRows)

  const open = useCallback((id: number): void => {
    tasks.openTask(id)
    setDetailId(id)
  }, [tasks.openTask])
  // Opens the first task once, like the other list pages; a later deselection is the user's.
  const autoOpened = useRef(false)
  const firstId = items[0]?.task.id
  useEffect(() => {
    if (autoOpened.current || detailId !== null || firstId === undefined || create) return
    autoOpened.current = true
    open(firstId)
  }, [detailId, firstId, create, open])

  if (create) {
    return (
      <NavSurfaceFrame data-page="tasks">
        <PageFrame width="wide" className="flex-1 min-w-0">
          <TaskComposer parentOptions={parentOptions} initialTitle={createDraft?.title} initialDescription={createDraft?.description} onCancel={() => setCreate(false)} onCreate={(patch) => {
            tasks.createTask(patch, open)
            setCreate(false)
          }} />
        </PageFrame>
      </NavSurfaceFrame>
    )
  }

  const activeProjects = (projects.projects ?? []).filter((project) => project.archived_at_ms == null)
  return (
    <NavSurfaceFrame data-page="tasks">
      <PageFrame width="wide" className="flex-1 min-w-0">
        <PageHeader
          heading="Tasks"
          description="Work for you and your agents. Each task runs in its own worktree and ends in a pull request."
          actions={<Inline gap="small">
            <Button variant="secondary" icon={IconFolderOpen} data-testid="tasks-projects" disabled={!client || projectWorkspaces.length === 0} onClick={() => { projects.clearError(); setProjectsOpen(true) }}>Projects</Button>
            <Button variant="primary" icon={IconPlus} onClick={() => { setDetailId(null); setCreate(true) }}>New task</Button>
          </Inline>}
        />
        {tasks.refusal?.id === null && <div role="status">{tasks.refusal.message}</div>}
        <ListDetail
          items={items}
          selectedId={detailId === null ? null : String(detailId)}
          onSelect={(id) => { if (id === null) { tasks.closeTask(); setDetailId(null) } else open(Number(id)) }}
          backLabel="Tasks"
          listHead={<TaskListHead query={query} onQuery={setQuery} projectFilter={projectFilter} onProjectFilter={setProjectFilter} projects={activeProjects} grouping={grouping} onGrouping={setGrouping} />}
          listEmpty={<TaskListEmpty filtered={query !== '' || projectFilter !== 'all'} />}
          footSection={grouping === 'queue' ? FINISHED_GROUP_LABEL : undefined}
          listFoot={finishedCount > 0 && <Button variant="ghost" size="sm" icon={showFinished ? IconChevronDown : IconChevronRight} aria-expanded={showFinished} data-testid="tasks-show-finished" onClick={() => setShowFinished((value) => !value)}>
            Done and archived <Text as="span" tone="faint">{finishedCount}</Text>
          </Button>}
          renderDetail={(item) => item === null
            ? <EmptyState icon={IconTasks} heading="Select a task" description="Choose a task to see its run, acceptance and activity." />
            : tasks.detail && tasks.detail.task.id === item.task.id ? (
              <TaskDetail
                client={client}
                summary={item.task}
                onStartRequested={onStartRequested}
                detail={tasks.detail}
                access={tasks.access}
                refusal={tasks.refusal}
                now={now}
                parentOptions={parentOptions}
                workspaceOptions={workspaces.map((option) => ({ value: option.path, label: option.name }))}
                sessions={sessions}
                startSettings={startSettings}
                primaryAction={<QueueActionButton task={item.task} sessions={sessions} onAction={() => runAction({
                  task: item.task, client, tasks, startSettings, sessions, onStartRequested, onOpenSession, onReview, onOpenExternal, open
                })} />}
                onReload={tasks.reloadTask}
                onSave={(id, revision, patch) => tasks.saveTask(id, revision, patch)}
                onCheck={tasks.check}
                onComment={tasks.comment}
                onArchive={tasks.archive}
                onStart={(id, agent, assignedWorkspace) => {
                  const target = tasks.detail?.task.workspace ?? assignedWorkspace
                  if (target) onStartRequested(id, target)
                  tasks.startTask(id, agent, assignedWorkspace)
                }}
                onRunControl={tasks.runControl}
                onOpenSession={onOpenSession}
                onReview={onReview}
              />
            ) : <Text role="status" tone="muted">Loading task…</Text>}
        />
      </PageFrame>
      <AnimOut open={projectsOpen} suppress="modal">
        <TaskProjectsDialog projects={projects} workspaces={workspaces.filter((item) => projectWorkspaces.includes(item.path))} initialWorkspace={workspace} onClose={() => setProjectsOpen(false)} />
      </AnimOut>
    </NavSurfaceFrame>
  )
}

function TaskListHead({ query, onQuery, projectFilter, onProjectFilter, projects, grouping, onGrouping }: {
  query: string
  onQuery: (value: string) => void
  projectFilter: string
  onProjectFilter: (value: string) => void
  projects: TaskProject[]
  grouping: TaskGrouping
  onGrouping: (value: TaskGrouping) => void
}): React.JSX.Element {
  return (
    <PanelListHead>
      <div className="grid gap-[var(--space-1-5)]">
        <div className="flex gap-[var(--space-1-5)]">
          <div className="min-w-0 flex-1">
            <PanelTextInput type="text" role="searchbox" aria-label="Search tasks" placeholder="Search tasks…" height="control" value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          </div>
          <Select aria-label="Filter by project" data-testid="tasks-project-filter" value={projectFilter} onChange={onProjectFilter} options={[
            { value: 'all', label: 'All projects' },
            ...projects.map((project) => ({ value: String(project.id), label: project.name })),
            { value: 'none', label: 'No project' }
          ]} />
        </div>
        <Segmented<TaskGrouping> aria-label="Group tasks" size="xs" value={grouping} onChange={onGrouping} options={[
          { value: 'queue', label: 'Queue', testId: 'tasks-group-queue' },
          { value: 'project', label: 'By project', testId: 'tasks-group-project' }
        ]} />
      </div>
    </PanelListHead>
  )
}

function TaskListEmpty({ filtered }: { filtered: boolean }): React.JSX.Element {
  return filtered
    ? <EmptyState icon={IconTasks} heading="No matching tasks" description="Change the search or project filter." copy="compact" />
    : <EmptyState icon={IconTasks} heading="No tasks" description="Create a task to hand work to an agent." copy="compact" />
}

/** The queue's next step for a task when the detail does not already offer it. */
function QueueActionButton({ task, sessions, onAction }: { task: TaskSummary; sessions: ReadonlyMap<number, SessionInfo>; onAction: () => void }): React.JSX.Element | null {
  const action = queueActionOf(task)
  const session = task.open_run?.session_id == null ? undefined : sessions.get(task.open_run.session_id)
  const offered = action === 'Answer' || action === 'Open PR' || action === 'Open pane' || (action === 'Review changes' && session !== undefined)
  if (!offered || isFinished(task)) return null
  return <Button variant={action === 'Open pane' ? 'secondary' : 'primary'} size="sm" data-testid="task-queue-action" onClick={onAction}>{action}</Button>
}

function TaskListMeta({ entry, notes }: { entry: TaskListEntry; notes: React.ReactNode[] }): React.JSX.Element {
  const { task } = entry
  const status = statusOf(task)
  const intake = intakeLabel(task)
  return (
    <span className="inline-flex min-w-0 items-center gap-[var(--space-1-5)]">
      {status ? <StatusLabel status={status} size="small" /> : <span>{STATUS_LABEL[task.status]}</span>}
      <span aria-hidden="true">·</span>
      <Text as="span" mono>{task.key}</Text>
      {intake && <span data-testid="task-intake-chip"><Chip variant="state" tone="info" label={intake} /></span>}
      {notes.map((note, index) => <Fragment key={index}><span aria-hidden="true">·</span><span className="truncate">{note}</span></Fragment>)}
    </span>
  )
}

function projectNotes(task: TaskSummary, delivery: TaskSummary | null, domain: TaskDomain | undefined): string[] {
  const notes: string[] = []
  if (domain?.kind === 'delivery') notes.push(`${domain.slice_done}/${domain.slice_total} slices`)
  if (delivery) notes.push(`Slice of ${delivery.key}`)
  if (domain && !domain.readiness.ready && !isFinished(task)) notes.push(`${domain.readiness.reasons.length} readiness ${domain.readiness.reasons.length === 1 ? 'issue' : 'issues'}`)
  return notes
}

function statusOf(task: TaskSummary): 'Needs input' | 'Ready' | 'Working' | 'Idle' | null {
  if (task.open_question || task.open_run?.state === 'waiting_for_input') return 'Needs input'
  if (task.status === 'in_review') return 'Ready'
  if (queueGroupOf(task) === 'working') return 'Working'
  if (queueGroupOf(task) === 'stopped') return 'Idle'
  return null
}

function metaOf(task: TaskSummary, now: number, sessions: ReadonlyMap<number, SessionInfo>, inboxRows: InboxRow[]): React.ReactNode {
  if (task.open_question) return `${task.open_run ? queueAgentLabel(task.open_run.provider) : 'The agent'} asks: “${task.open_question.question}”`
  if (task.open_run?.state === 'waiting_for_input') {
    const question = questionFor(task, sessions, inboxRows)
    return question ? `${queueAgentLabel(task.open_run.provider)} asks: “${question}”` : `${queueAgentLabel(task.open_run.provider)} needs input`
  }
  if (task.status === 'in_review' && task.open_run?.pr_url && isPullRequestUrl(task.open_run.pr_url)) {
    const number = pullRequestNumber(task.open_run.pr_url)
    return number ? `#${number}` : 'Pull request'
  }
  if (task.open_run) return <>{taskAgentLabel(task.open_run.provider)} · {formatAge(task.open_run.started_at_ms, now)}</>
  if (task.status === 'in_progress' || task.status === 'canceled') return <>stopped {formatAgo(task.updated_at_ms, now)} · acceptance {task.acceptance_checked}/{task.acceptance_total}</>
  if (task.origin?.kind === 'harness_finding') return 'From Harness'
  return task.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No workspace'
}

function pullRequestNumber(url: string): string | null {
  return url.match(/\/pull\/(\d+)(?:\/|[?#]|$)/)?.[1] ?? null
}

function runAction({ task, client, tasks, startSettings, sessions, onStartRequested, onOpenSession, onReview, onOpenExternal, open }: {
  task: TaskSummary
  client: HoustonClient | null
  tasks: ReturnType<typeof useTasks>
  startSettings: ReturnType<typeof useTaskStartSettings>['settings']
  sessions: ReadonlyMap<number, SessionInfo>
  onStartRequested: (taskId: number, workspace: string) => void
  onOpenSession: (id: number) => void
  onReview: (session: SessionInfo) => void
  onOpenExternal: (url: string) => void
  open: (id: number) => void
}): void {
  const action = queueActionOf(task)
  if (action === 'Open PR' && task.open_run?.pr_url && isPullRequestUrl(task.open_run.pr_url)) {
    onOpenExternal(task.open_run.pr_url)
    return
  }
  if ((action === 'Answer' || action === 'Open pane') && task.open_run?.session_id != null) {
    onOpenSession(task.open_run.session_id)
    return
  }
  if (action === 'Start' && client) {
    const agent = (startSettings?.agent ?? 'claude') as AgentKind
    const target = task.workspace
    if (target) onStartRequested(task.id, target)
    tasks.startTask(task.id, agent, target)
    return
  }
  const session = task.open_run?.session_id == null ? undefined : sessions.get(task.open_run.session_id)
  if (action === 'Review changes' && session) onReview(session)
  else open(task.id)
}

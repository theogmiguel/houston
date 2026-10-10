import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { InboxRow } from '../../houston/generated/InboxRow'
import type { PullRequestLink } from '../../houston/generated/PullRequestLink'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { HoustonClient, SessionInfo } from '../../houston/client'
import { useTasks } from '../../houston/useTasks'
import { useFactorySettings } from '../../houston/useFactorySettings'
import { openSettings } from '../../settingsNav'
import {
  Button, Card, Checkbox, Chip, ContentSection, DataTable, Inline, NavSurfaceFrame, Notice, PageFrame, PageHeader,
  StatusLabel, Text, type DataTableColumn, type StatusLabelValue
} from '../ui'
import { formatAge, intakeLabel, STATUS_LABEL, taskAgentLabel } from '../tasks/format'
import {
  activityPhrase, landingTasks, needsYouItems, pullRequestNumberOf, pullRequestUrlOf, readyBacklog, slackWaiting, workingTasks,
  type NeedsYouItem
} from '../tasks/factoryModel'
import { queueAgentLabel, useInboxRows } from '../tasks/needsInput'
import { TaskQuestionCard } from '../tasks/TaskQuestionCard'

export interface FactorySurfaceProps {
  client: HoustonClient | null
  workspaces: { path: string; name: string }[]
  sessions: ReadonlyMap<number, SessionInfo>
  now: number
  /** Pull requests the renderer already tracks; a match by URL gives Landing its state and the in-app screen. */
  pullRequests?: readonly PullRequestLink[]
  onOpenSession: (sessionId: number) => void
  onOpenTask: (taskId: number) => void
  onOpenPullRequest?: (link: PullRequestLink) => void
  onOpenExternal: (url: string) => void
  onStartRequested: (taskId: number, workspace: string) => void
}

/// The Factory: every workspace's tasks as one dispatch desk — what needs the
/// user, what runs, what waits to start, what is landing, and the limits.
export function FactorySurface(props: FactorySurfaceProps): React.JSX.Element {
  const { client, sessions, now } = props
  const tasks = useTasks(client, null, 'all')
  const allTasks = useMemo(() => tasks.snapshot?.tasks ?? [], [tasks.snapshot])
  const loaded = tasks.snapshot !== null
  // Keyed by content: the caller rebuilds `workspaces` on every render.
  const pathsKey = [...new Set([
    ...props.workspaces.map((item) => item.path),
    ...allTasks.map((task) => task.workspace ?? '')
  ].filter(Boolean))].join('\n')
  const workspacePaths = useMemo(() => pathsKey ? pathsKey.split('\n') : [], [pathsKey])
  const [inboxRows, setInboxRows] = useState<InboxRow[]>([])
  useInboxRows(client, workspacePaths, setInboxRows)
  const agents = useStartAgents(client, workspacePaths)
  const factory = useFactorySettings(client)

  const needs = useMemo(() => needsYouItems(allTasks, sessions, inboxRows), [allTasks, sessions, inboxRows])
  const working = useMemo(() => workingTasks(allTasks), [allTasks])
  const slack = useMemo(() => slackWaiting(allTasks), [allTasks])
  const backlog = useMemo(() => readyBacklog(allTasks), [allTasks])
  const landing = useMemo(() => landingTasks(allTasks, now), [allTasks, now])
  const workspaceName = (path: string | null | undefined): string =>
    props.workspaces.find((item) => item.path === path)?.name ?? path?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No workspace'
  const firstNeed = useRef<HTMLDivElement>(null)

  const start = (task: TaskSummary): void => {
    if (!task.workspace) return
    props.onStartRequested(task.id, task.workspace)
    tasks.startTask(task.id, agents.get(task.workspace) ?? 'claude', task.workspace)
  }
  const refusedKey = tasks.refusal?.id == null ? null : allTasks.find((task) => task.id === tasks.refusal?.id)?.key ?? null

  return (
    <NavSurfaceFrame data-page="factory">
      <PageFrame width="wide" className="flex-1 min-w-0">
        <PageHeader
          heading="Factory"
          count={needs.length}
          description="Every workspace's tasks in one place: what needs you, what is running, what waits to start and what is landing."
          actions={<Button variant="secondary" data-testid="factory-next" disabled={needs.length === 0} onClick={() => {
            firstNeed.current?.scrollIntoView?.({ block: 'nearest' })
            firstNeed.current?.focus()
          }}>Next</Button>}
        />
        {tasks.refusal && <Notice tone="danger">{refusedKey ? `${refusedKey}: ` : ''}{tasks.refusal.message}</Notice>}
        <ContentSection heading="Needs you" description="Questions, runs waiting for input and results in review, oldest first." data-testid="factory-needs-you">
          {!loaded ? <Text role="status" tone="muted">Loading tasks…</Text>
            : needs.length === 0 ? <Text tone="muted">Nothing needs you.</Text>
              : needs.map((item, index) => <NeedsYouRow
                key={`${item.kind}:${item.task.id}`}
                ref={index === 0 ? firstNeed : undefined}
                item={item}
                now={now}
                workspace={workspaceName(item.task.workspace)}
                client={client}
                refusal={tasks.refusal}
                onOpenSession={props.onOpenSession}
                onOpenTask={props.onOpenTask}
                onOpenPullRequest={(task) => openPullRequest(task, props)}
              />)}
        </ContentSection>
        <ContentSection heading="Working" description="Live task runs across all workspaces." data-testid="factory-working">
          <DataTable
            aria-label="Working"
            rows={loaded ? working : undefined}
            getRowId={(task) => String(task.id)}
            emptySetLabel="No task is running."
            columns={workingColumns(sessions, now, props.onOpenSession)}
          />
        </ContentSection>
        <ContentSection heading="Sources" description="Slack requests waiting to start and the ready backlog. Tracker imports appear in the backlog." data-testid="factory-sources">
          <DataTable
            aria-label="Slack requests"
            rows={loaded ? slack : undefined}
            getRowId={(task) => String(task.id)}
            emptySetLabel="No Slack request is waiting."
            columns={slackColumns(now, workspaceName, props.onOpenTask)}
          />
          <ReadyBacklog tasks={loaded ? backlog : undefined} agents={agents} workspaceName={workspaceName} onStart={start} />
        </ContentSection>
        <ContentSection heading="Landing" description="Pull requests of tasks in review or done this week. Merge from the pull request screen." data-testid="factory-landing">
          <DataTable
            aria-label="Landing"
            rows={loaded ? landing : undefined}
            getRowId={(task) => String(task.id)}
            emptySetLabel="No pull request is landing."
            columns={landingColumns(props)}
          />
        </ContentSection>
        <ContentSection heading="Limits" description="Concurrency and review load the factory works within." data-testid="factory-limits">
          <FactoryLimits settings={factory.settings} />
        </ContentSection>
      </PageFrame>
    </NavSurfaceFrame>
  )
}

function linkFor(task: TaskSummary, pullRequests: readonly PullRequestLink[] | undefined): PullRequestLink | null {
  const url = pullRequestUrlOf(task)
  return url ? pullRequests?.find((link) => link.url === url) ?? null : null
}

function openPullRequest(task: TaskSummary, props: FactorySurfaceProps): void {
  const link = linkFor(task, props.pullRequests)
  if (link && props.onOpenPullRequest) props.onOpenPullRequest(link)
  else {
    const url = pullRequestUrlOf(task)
    if (url) props.onOpenExternal(url)
  }
}

/** The default Start agent of each workspace, from `task_start_settings`. */
function useStartAgents(client: HoustonClient | null, workspaces: string[]): ReadonlyMap<string, AgentKind> {
  const [agents, setAgents] = useState<ReadonlyMap<string, AgentKind>>(new Map())
  useEffect(() => {
    if (!client || workspaces.length === 0) return
    const off = client.subscribe('task_start_settings', (msg) => setAgents((current) => new Map(current).set(msg.workspace, msg.agent)))
    workspaces.forEach((path) => client.taskStartSettingsGet(path))
    return off
  }, [client, workspaces])
  return agents
}

function TaskCell({ task }: { task: TaskSummary }): React.JSX.Element {
  return <span className="inline-flex min-w-0 items-center gap-[var(--space-1-5)]">
    <Text as="span" mono tone="faint">{task.key}</Text>
    <Text as="span" className="truncate">{task.title}</Text>
  </span>
}

const NEED_STATUS: Readonly<Record<NeedsYouItem['kind'], StatusLabelValue>> = {
  question: 'Needs input',
  input: 'Needs input',
  review: 'Ready'
}

function NeedsYouRow({ ref, item, now, workspace, client, refusal, onOpenSession, onOpenTask, onOpenPullRequest }: {
  ref?: React.Ref<HTMLDivElement>
  item: NeedsYouItem
  now: number
  workspace: string
  client: HoustonClient | null
  refusal: ReturnType<typeof useTasks>['refusal']
  onOpenSession: (sessionId: number) => void
  onOpenTask: (taskId: number) => void
  onOpenPullRequest: (task: TaskSummary) => void
}): React.JSX.Element {
  const { task } = item
  const agent = task.open_run ? queueAgentLabel(task.open_run.provider) : 'The agent'
  return <div ref={ref} tabIndex={-1} data-testid="factory-needs-item" data-kind={item.kind}><Card padding="sm" className="grid gap-[var(--space-2)]">
    <Inline gap="small" wrap>
      <StatusLabel status={NEED_STATUS[item.kind]} size="small" />
      <TaskCell task={task} />
      <Text as="span" size="small" tone="muted">{workspace} · {formatAge(item.at, now)}</Text>
      <span className="flex-1" />
      <Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id)}>Open task</Button>
    </Inline>
    {item.kind === 'question' && <TaskQuestionCard question={item.question} client={client} refusal={refusal} onOpenSession={onOpenSession} labelled={false} keyboard={false} />}
    {item.kind === 'input' && <Inline gap="small" wrap>
      <Text size="small">{item.text ? `${agent} asks: “${item.text}”` : `${agent} needs input`}</Text>
      <span className="flex-1" />
      {item.sessionId != null && <Button variant="secondary" size="sm" data-testid="factory-open-pane" onClick={() => onOpenSession(item.sessionId!)}>Open pane</Button>}
    </Inline>}
    {item.kind === 'review' && <Inline gap="small" wrap>
      <Text size="small">The result is ready for review.</Text>
      <span className="flex-1" />
      {pullRequestUrlOf(task) && <Button variant="secondary" size="sm" onClick={() => onOpenPullRequest(task)}>Open pull request</Button>}
      <Button variant="primary" size="sm" data-testid="factory-review" onClick={() => onOpenTask(task.id)}>Review</Button>
    </Inline>}
  </Card></div>
}

function workingColumns(sessions: ReadonlyMap<number, SessionInfo>, now: number, onOpenSession: (id: number) => void): DataTableColumn<TaskSummary>[] {
  const sessionOf = (task: TaskSummary): SessionInfo | undefined => task.open_run?.session_id == null ? undefined : sessions.get(task.open_run.session_id)
  return [
    { key: 'task', header: 'Task', render: (task) => <TaskCell task={task} /> },
    { key: 'agent', header: 'Agent', render: (task) => task.open_run ? taskAgentLabel(task.open_run.provider) : '—' },
    { key: 'model', header: 'Model', render: (task) => sessionOf(task)?.activity?.model ?? '—' },
    { key: 'worktree', header: 'Worktree', render: (task) => <Text as="span" mono size="small" className="truncate">{task.open_run?.branch ?? task.open_run?.worktree_path ?? '—'}</Text> },
    { key: 'doing', header: 'Doing', render: (task) => <Text as="span" size="small" tone="muted" className="truncate">{activityPhrase(sessionOf(task)) ?? '—'}</Text> },
    { key: 'time', header: 'Time', numeric: true, render: (task) => task.open_run ? formatAge(task.open_run.started_at_ms, now) : '—' },
    { key: 'open', header: '', render: (task) => task.open_run?.session_id != null
      ? <Button variant="ghost" size="sm" onClick={() => onOpenSession(task.open_run!.session_id!)}>Open pane</Button>
      : null }
  ]
}

function slackColumns(now: number, workspaceName: (path: string | null | undefined) => string, onOpenTask: (id: number) => void): DataTableColumn<TaskSummary>[] {
  return [
    { key: 'task', header: 'Slack request', render: (task) => <TaskCell task={task} /> },
    { key: 'state', header: 'State', render: (task) => <span data-testid="task-intake-chip"><Chip variant="state" tone="info" label={intakeLabel(task) ?? ''} /></span> },
    { key: 'workspace', header: 'Workspace', render: (task) => workspaceName(task.workspace) },
    { key: 'age', header: 'Filed', numeric: true, render: (task) => formatAge(task.created_at_ms, now) },
    { key: 'open', header: '', render: (task) => <Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id)}>Open task</Button> }
  ]
}

function ReadyBacklog({ tasks, agents, workspaceName, onStart }: {
  tasks: TaskSummary[] | undefined
  agents: ReadonlyMap<string, AgentKind>
  workspaceName: (path: string | null | undefined) => string
  onStart: (task: TaskSummary) => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const startable = (tasks ?? []).filter((task) => task.workspace != null)
  const chosen = startable.filter((task) => selected.has(task.id))
  const toggle = (id: number, on: boolean): void => setSelected((current) => {
    const next = new Set(current)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })
  const columns: DataTableColumn<TaskSummary>[] = [
    { key: 'pick', header: '', width: '32px', render: (task) => <Checkbox
      aria-label={`Select ${task.key}`}
      checked={selected.has(task.id)}
      disabled={task.workspace == null}
      onChange={(on) => toggle(task.id, on)}
    /> },
    { key: 'task', header: 'Ready backlog', render: (task) => <TaskCell task={task} /> },
    { key: 'workspace', header: 'Workspace', render: (task) => workspaceName(task.workspace) },
    { key: 'agent', header: 'Agent', render: (task) => task.workspace ? taskAgentLabel(agents.get(task.workspace) ?? 'claude') : 'Assign a workspace first' },
    { key: 'start', header: '', render: (task) => <Button variant="secondary" size="sm" disabled={task.workspace == null} onClick={() => onStart(task)}>Start in worktree</Button> }
  ]
  return <div className="grid gap-[var(--space-2)]">
    <Inline gap="small">
      <Text size="small" tone="muted">Starts respect each task's readiness; the daemon refuses a task that is not ready.</Text>
      <span className="flex-1" />
      <Button variant="primary" size="sm" data-testid="factory-start-selected" disabled={chosen.length === 0} onClick={() => {
        chosen.forEach(onStart)
        setSelected(new Set())
      }}>{chosen.length > 0 ? `Start selected (${chosen.length})` : 'Start selected'}</Button>
    </Inline>
    <DataTable aria-label="Ready backlog" rows={tasks} getRowId={(task) => String(task.id)} emptySetLabel="No todo task is waiting." columns={columns} />
  </div>
}

function prState(link: PullRequestLink | null): { status: StatusLabelValue; label: string } | null {
  if (!link) return null
  if (link.state === 'merged') return { status: 'Done', label: 'Merged' }
  if (link.state === 'closed') return { status: 'Ended', label: 'Closed' }
  if (link.checks === 'failing') return { status: 'Failed', label: 'Open · checks failing' }
  if (link.checks === 'running') return { status: 'Working', label: 'Open · checks running' }
  if (link.checks === 'passing') return { status: 'Verified', label: 'Open · checks passing' }
  return { status: 'Open', label: 'Open' }
}

function landingColumns(props: FactorySurfaceProps): DataTableColumn<TaskSummary>[] {
  return [
    { key: 'task', header: 'Task', render: (task) => <TaskCell task={task} /> },
    { key: 'pr', header: 'Pull request', render: (task) => {
      const number = pullRequestNumberOf(task)
      const label = number != null ? `#${number}` : 'Pull request'
      return pullRequestUrlOf(task)
        ? <Button variant="ghost" size="sm" data-testid="factory-landing-pr" onClick={() => openPullRequest(task, props)}>{label}</Button>
        : <Text as="span" size="small">{label}</Text>
    } },
    { key: 'pr-state', header: 'State', render: (task) => {
      const state = prState(linkFor(task, props.pullRequests))
      return state ? <span className="inline-flex items-center gap-[var(--space-1-5)]"><StatusLabel status={state.status} variant="dot" size="small" /><Text as="span" size="small">{state.label}</Text></span> : <Text as="span" size="small" tone="muted">—</Text>
    } },
    { key: 'status', header: 'Task', render: (task) => STATUS_LABEL[task.status] }
  ]
}

function FactoryLimits({ settings }: { settings: ReturnType<typeof useFactorySettings>['settings'] }): React.JSX.Element {
  if (!settings) return <Text role="status" tone="muted">Loading limits…</Text>
  const slotsFull = settings.liveRuns >= settings.liveRunsMax
  const paused = settings.needsYou >= settings.needsYouMax
  return <div className="grid gap-[var(--space-2)]">
    <Inline gap="small">
      <Text>Live runs</Text>
      <Text as="span" mono data-testid="factory-live-runs">{settings.liveRuns} / {settings.liveRunsMax}</Text>
      {slotsFull && <StatusLabel status="Waiting for a slot" size="small" />}
    </Inline>
    <Inline gap="small">
      <Text>Needs you</Text>
      <Text as="span" mono data-testid="factory-needs-you-count">{settings.needsYou} / {settings.needsYouMax}</Text>
      {paused && <StatusLabel status="Paused" size="small" />}
    </Inline>
    <Text size="small" tone="muted">Automatic starts pause while Needs you is at its limit, until you clear an item.</Text>
    <Inline gap="small"><Button variant="ghost" size="sm" data-testid="factory-limits-settings" onClick={() => openSettings('tasks')}>Change limits in Settings ▸ Tasks</Button></Inline>
  </div>
}

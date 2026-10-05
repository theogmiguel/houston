import { useEffect, useMemo, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SessionInfo, HoustonClient } from '../../houston/client'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { useTaskStartSettings, useTasks } from '../../houston/useTasks'
import { Button, Card, DoneDisclosure, Drawer, PageFrame, PageHeader, SectionHead, StatusLabel, TaskQueueMeta } from '../ui'
import { IconPlus } from '../icons'
import { TaskComposer } from '../tasks/TaskComposer'
import { TaskDetail } from '../tasks/TaskDetail'
import { formatAge, queueActionOf, queueGroupOf, queueGroups, taskAgentLabel } from '../tasks/format'
import type { InboxRow } from '../../houston/generated/InboxRow'

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
  const groups = useMemo(() => queueGroups(tasks.snapshot?.tasks ?? []), [tasks.snapshot])
  const inboxWorkspaces = useMemo(() => [...new Set([
    workspace,
    ...workspaces.map((item) => item.path),
    ...(tasks.snapshot?.tasks ?? []).map((task) => task.workspace ?? '')
  ].filter(Boolean))], [workspace, workspaces, tasks.snapshot?.tasks])
  const parentOptions = useMemo(() => (tasks.snapshot?.tasks ?? [])
    .filter((task) => task.archived_at_ms == null && task.id !== detailId)
    .map((task) => ({ value: String(task.id), label: `${task.key} — ${task.title}` })), [tasks.snapshot, detailId])

  useEffect(() => {
    if (openTaskId === undefined) return
    setCreate(false)
    setDetailId(openTaskId)
    tasks.openTask(openTaskId)
    onOpenTaskHandled?.()
  }, [openTaskId, onOpenTaskHandled, tasks.openTask])
  useEffect(() => {
    if (!compose && !createDraft) return
    setDetailId(null)
    setCreate(true)
    onCreateHandled?.()
  }, [compose, createDraft, onCreateHandled])

  useEffect(() => {
    if (!client || inboxWorkspaces.length === 0) return
    const known = new Set(inboxWorkspaces)
    const offRows = client.subscribe('inbox_rows', (message) => {
      if (known.has(message.workspace)) setInboxRows((current) => [...current.filter((row) => row.workspace !== message.workspace), ...message.rows])
    })
    const offChanged = client.subscribe('inbox_changed', (message) => {
      if (known.has(message.workspace)) setInboxRows((current) => [...current.filter((row) => row.id !== message.row.id), message.row])
    })
    inboxWorkspaces.forEach((path) => client.inboxList(path))
    return () => { offRows(); offChanged() }
  }, [client, inboxWorkspaces])

  const open = (id: number): void => {
    tasks.openTask(id)
    setDetailId(id)
  }
  const close = (): void => {
    tasks.closeTask()
    setDetailId(null)
  }

  return (
    <div data-testid="nav-surface" data-page="tasks" className="h-full min-h-0 overflow-y-auto">
      <PageFrame width="form">
        {create ? (
          <TaskComposer parentOptions={parentOptions} initialTitle={createDraft?.title} initialDescription={createDraft?.description} onCancel={() => setCreate(false)} onCreate={(patch) => {
            tasks.saveTask(null, null, patch)
            setCreate(false)
          }} />
        ) : <>
        <PageHeader
          heading="Tasks"
          description="Work for you and your agents. Each task runs in its own worktree and ends in a pull request."
          actions={<Button variant="primary" icon={IconPlus} onClick={() => { setDetailId(null); setCreate(true) }}>New task</Button>}
        />
        {tasks.refusal?.id === null && <div role="status">{tasks.refusal.message}</div>}
        {groups.filter((group) => group.key !== 'done').map((group) => (
          <section key={group.key} className="grid gap-[var(--space-1-5)]" data-testid={`tasks-queue-${group.key}`}>
            <SectionHead title={group.label} count={group.tasks.length} />
            <Card>
              {group.tasks.map((task) => (
                <QueueRow key={task.id} task={task} now={now} sessions={sessions} inboxRows={inboxRows} onOpen={() => open(task.id)} onAction={() => runAction({
                  task, client, tasks, startSettings, sessions, onStartRequested, onOpenSession, onReview, onOpenExternal, open
                })} />
              ))}
            </Card>
          </section>
        ))}
        {groups.find((group) => group.key === 'done') && (
          <DoneDisclosure count={groups.find((group) => group.key === 'done')!.tasks.filter((task) => queueGroupOf(task) === 'done').length}>
            <Card>
              {groups.find((group) => group.key === 'done')!.tasks.map((task) => (
                <QueueRow key={task.id} task={task} now={now} sessions={sessions} inboxRows={inboxRows} onOpen={() => open(task.id)} onAction={() => open(task.id)} />
              ))}
            </Card>
          </DoneDisclosure>
        )}
      </>}
      </PageFrame>
      <Drawer open={!create && detailId !== null} heading="Task detail" onClose={close} hideHeader tone="content">
        {tasks.detail ? (
          <TaskDetail
            detail={tasks.detail}
            access={tasks.access}
            refusal={tasks.refusal}
            now={now}
            parentOptions={parentOptions}
            workspaceOptions={workspaces.map((item) => ({ value: item.path, label: item.name }))}
            sessions={sessions}
            startSettings={startSettings}
            onBack={close}
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
            presentation="drawer"
          />
        ) : <div role="status">Loading task…</div>}
      </Drawer>
    </div>
  )
}

function QueueRow({ task, now, sessions, inboxRows, onOpen, onAction }: {
  task: TaskSummary
  now: number
  sessions: ReadonlyMap<number, SessionInfo>
  inboxRows: InboxRow[]
  onOpen: () => void
  onAction: () => void
}): React.JSX.Element {
  const action = queueActionOf(task)
  const status = statusOf(task)
  return (
    <Card.Row
      density="compact"
      className="gap-[var(--space-2-5)]"
      heading={<Button variant="text" size="sm" className="min-w-0 truncate" onClick={onOpen}>{task.title}</Button>}
      meta={<TaskQueueMeta taskKey={task.key}>{metaOf(task, now, sessions, inboxRows)}</TaskQueueMeta>}
      status={status ? <StatusLabel status={status} /> : undefined}
      action={<Button variant={action === 'Open pane' ? 'ghost' : 'secondary'} onClick={onAction}>{action}</Button>}
    />
  )
}

function statusOf(task: TaskSummary): 'Needs input' | 'Ready' | 'Working' | 'Idle' | null {
  if (task.open_run?.state === 'waiting_for_input') return 'Needs input'
  if (task.status === 'in_review') return 'Ready'
  if (queueGroupOf(task) === 'working') return 'Working'
  if (queueGroupOf(task) === 'stopped') return 'Idle'
  return null
}

function metaOf(task: TaskSummary, now: number, sessions: ReadonlyMap<number, SessionInfo>, inboxRows: InboxRow[]): React.ReactNode {
  if (task.open_run?.state === 'waiting_for_input') {
    const question = questionFor(task, sessions, inboxRows)
    return question ? `${queueAgentLabel(task.open_run.provider)} asks: “${question}”` : `${queueAgentLabel(task.open_run.provider)} needs input`
  }
  if (task.status === 'in_review' && task.ref_url) {
    const number = pullRequestNumber(task.ref_url)
    return number ? `#${number}` : 'Pull request'
  }
  if (task.open_run) return <>{taskAgentLabel(task.open_run.provider)} · {formatAge(task.open_run.started_at_ms, now)}</>
  if (task.status === 'in_progress' || task.status === 'canceled') return <>stopped {formatAge(task.updated_at_ms, now)} ago · acceptance {task.acceptance_checked}/{task.acceptance_total}</>
  if (task.origin?.kind === 'harness_finding') return 'From Harness'
  return task.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No workspace'
}

function questionFor(task: TaskSummary, sessions: ReadonlyMap<number, SessionInfo>, rows: InboxRow[]): string | null {
  const sessionId = task.open_run?.session_id
  if (sessionId == null) return null
  const holdReason = sessions.get(sessionId)?.delegation?.hold_reason?.trim()
  if (holdReason) return holdReason
  const row = rows
    .filter((item) => item.kind === 'needs_input' && item.from_session === sessionId && item.resolved_at == null)
    .sort((a, b) => Number(b.created_at - a.created_at))[0]
  if (!row) return null
  const body = row.body.trim()
  const specific = body.match(/^this child needs input:\s*(.*?)\s*\.?\s*Inspect it\s*\(/i)?.[1]?.trim().replace(/\.\s*$/, '')
  if (specific) return specific
  if (body.includes('did not say why')) return null
  return body || row.summary || null
}

function queueAgentLabel(provider: AgentKind): string {
  const label = taskAgentLabel(provider)
  return provider === 'claude' ? `${label} Code` : label
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
  if (action === 'Open PR' && task.ref_url) {
    onOpenExternal(task.ref_url)
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

import { useEffect, useMemo, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { HoustonClient } from '../../houston/client'
import { sendTaskWire, type TaskDomain, type TaskProject, type TaskTrackerLink, linkIsPullRequest } from '../../houston/taskDomain'
import { Button, Card, Field, InlineLink, Notice, PageFrame, PageHeader, SectionHead, Select, Text, TextArea, TextInput } from '../ui'

export function ProjectsSurface({ client, workspace, workspaces, onOpenSession }: {
  client: HoustonClient | null
  workspace: string
  workspaces: { path: string; name: string }[]
  onOpenSession: (sessionId: number) => void
}): React.JSX.Element {
  const [scope, setScope] = useState(workspace || '')
  const [projects, setProjects] = useState<TaskProject[] | null>(null)
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null)
  const [domains, setDomains] = useState<Record<number, TaskDomain>>({})
  const [links, setLinks] = useState<Record<number, TaskTrackerLink[]>>({})
  const [linksLoaded, setLinksLoaded] = useState<Record<number, boolean>>({})
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncState, setSyncState] = useState<{ at: number | null; error: string | null } | null>(null)

  useEffect(() => setScope(workspace || ''), [workspace])
  useEffect(() => {
    setProjects(null)
    setTasks(null)
    setDomains({})
    setLinks({})
    setLinksLoaded({})
    setSelectedProjectId(null)
    setSelectedTaskId(null)
    setError(null)
    if (!client || !scope) return
    const off = client.subscribeAll((msg) => {
      if (msg.type === 'task_projects_state' && msg.workspace === scope) {
        setBusy(false)
        setProjects(msg.projects)
        setSelectedProjectId((id) => id != null && msg.projects.some((project) => project.id === id) ? id : msg.projects.find((project) => project.archived_at_ms == null)?.id ?? null)
      }
      if (msg.type === 'task_snapshot' && msg.scope === scope) {
        setTasks(msg.tasks)
        setLinksLoaded({})
        msg.tasks.forEach((task) => {
          sendTaskWire(client, { type: 'task_domain_get', id: task.id })
          sendTaskWire(client, { type: 'task_tracker_links_get', task_id: task.id })
        })
      }
      if (msg.type === 'task_changed' && (msg.workspace == null || msg.workspace === scope)) client.taskSnapshot(scope)
      if (msg.type === 'task_project_changed' && msg.workspace === scope) sendTaskWire(client, { type: 'task_projects_list', workspace: scope })
      if (msg.type === 'task_domain_state') setDomains((current) => ({ ...current, [msg.domain.task_id]: msg.domain }))
      if (msg.type === 'task_plan_changed') sendTaskWire(client, { type: 'task_domain_get', id: msg.id })
      if (msg.type === 'task_plan_started') onOpenSession(msg.session_id)
      if (msg.type === 'task_tracker_links') {
        setLinks((current) => ({ ...current, [msg.task_id]: msg.links }))
        setLinksLoaded((current) => ({ ...current, [msg.task_id]: true }))
      }
      if (msg.type === 'task_refused') {
        setBusy(false)
        setError(msg.message)
      }
      if (msg.type === 'task_tracker_conflict_resolved') setLinks((current) => ({ ...current, [msg.task_id]: (current[msg.task_id] ?? []).map((link) => link.provider === msg.link.provider && link.external_id === msg.link.external_id ? msg.link : link) }))
    })
    sendTaskWire(client, { type: 'task_projects_list', workspace: scope })
    client.taskSnapshot(scope)
    return off
  }, [client, scope, onOpenSession])

  const project = projects?.find((item) => item.id === selectedProjectId) ?? null
  const assignedTasks = useMemo(() => (tasks ?? []).filter((task) => domains[task.id]?.project_id === selectedProjectId), [tasks, domains, selectedProjectId])
  const unassignedTasks = useMemo(() => (tasks ?? []).filter((task) => domains[task.id] && domains[task.id].project_id == null), [tasks, domains])
  const selectedTask = (tasks ?? []).find((task) => task.id === selectedTaskId) ?? null
  const selectedDomain = selectedTask ? domains[selectedTask.id] ?? null : null
  const deliveries = assignedTasks.filter((task) => domains[task.id]?.kind === 'delivery')
  const slices = assignedTasks.filter((task) => domains[task.id]?.kind === 'slice')
  const projectLinks = assignedTasks.flatMap((task) => links[task.id] ?? [])
  const projectLinksLoaded = assignedTasks.every((task) => linksLoaded[task.id])
  const projectSyncLabel = !projectLinksLoaded ? 'Loading tracker links' : projectLinks.length === 0 ? 'No tracker links' : projectLinks.some((link) => link.sync_state.state === 'error') ? 'Tracker sync has errors' : projectLinks.some((link) => link.sync_state.state === 'diverged') ? 'Tracker data has unresolved divergence' : projectLinks.some((link) => link.sync_state.state === 'pending') ? 'Tracker sync is pending' : 'Linked tracker data is in sync'

  const saveProject = (draft: { name: string; external_url: string | null; tracker_description: string | null; local_decisions: string[] }): void => {
    if (!client || !scope || !draft.name.trim()) return
    setBusy(true)
    setError(null)
    sendTaskWire(client, { type: 'task_project_save', workspace: scope, id: project?.id ?? null, expected_revision: project?.revision ?? null, ...draft, name: draft.name.trim() })
  }

  const createProject = (): void => {
    if (!client || !scope) return
    setBusy(true)
    setError(null)
    sendTaskWire(client, { type: 'task_project_save', workspace: scope, id: null, expected_revision: null, name: 'New project', external_url: null, tracker_description: null, local_decisions: [] })
  }
  const saveDomain = (patch: { kind?: 'delivery' | 'slice'; project_id?: number | null; blocked_by?: number[] }): void => {
    if (!client || !selectedTask || !selectedDomain) return
    sendTaskWire(client, { type: 'task_domain_save', id: selectedTask.id, expected_revision: selectedTask.revision, ...patch })
  }

  if (!scope) return <PageFrame width="wide"><PageHeader heading="Projects" description="Projects collect deliveries and slice tasks for a workspace." /><Text tone="muted">Select a workspace to see its projects.</Text></PageFrame>
  if (!client) return <PageFrame width="wide"><PageHeader heading="Projects" description="Projects collect deliveries and slice tasks for a workspace." /><Notice tone="info">Connect to the Houston daemon to load projects.</Notice></PageFrame>

  return <PageFrame width="wide" data-testid="projects-surface">
    <PageHeader heading="Projects" description="Track deliveries, slice tasks, readiness and tracker sync for this workspace." actions={<Select aria-label="Workspace" data-testid="projects-workspace" value={scope} options={workspaces.map((item) => ({ value: item.path, label: item.name }))} onChange={setScope} />} />
    {error && <Notice tone="danger">{error}</Notice>}
    {projects === null || tasks === null ? <Text role="status" aria-busy="true" tone="muted">Loading workspace projects…</Text> : <div className="grid min-h-0 gap-[var(--space-4)] lg:grid-cols-[minmax(13rem,0.8fr)_minmax(0,2fr)]">
      <section className="grid content-start gap-[var(--space-2)]" aria-label="Projects">
        <SectionHead title="Projects" count={projects.filter((item) => item.archived_at_ms == null).length} />
        <Card>
          {projects.filter((item) => item.archived_at_ms == null).map((item) => <Card.Row key={item.id} density="compact" heading={<Button variant="text" size="sm" aria-current={item.id === selectedProjectId ? 'page' : undefined} onClick={() => { setSelectedProjectId(item.id); setSelectedTaskId(null) }}>{item.name}</Button>} meta={`Project ${item.id}`} />)}
          {projects.filter((item) => item.archived_at_ms != null).map((item) => <Card.Row key={item.id} density="compact" heading={item.name} meta="Archived" action={<Button variant="ghost" onClick={() => sendTaskWire(client, { type: 'task_project_archive', id: item.id, archived: false, expected_revision: item.revision })}>Restore</Button>} />)}
          {projects.every((item) => item.archived_at_ms != null) && <Card.Content><Text tone="muted">No active projects yet.</Text></Card.Content>}
        </Card>
        <Button variant="secondary" onClick={createProject}>New project</Button>
      </section>
      <section className="grid content-start gap-[var(--space-4)] min-w-0">
        {!project ? <Text as="p" role="status" tone="muted">Choose a project or create one to organize this workspace’s tasks.</Text> : <>
          <ProjectEditor project={project} busy={busy} onSave={saveProject} onArchive={() => sendTaskWire(client, { type: 'task_project_archive', id: project.id, archived: true, expected_revision: project.revision })} />
          <Text role="status" size="small" tone="muted">{projectSyncLabel}</Text>
          <section className="grid gap-[var(--space-2)]">
            <SectionHead title="Deliveries" count={deliveries.length} />
            <Card>{deliveries.length ? deliveries.map((task) => <TaskRow key={task.id} task={task} domains={domains} links={links[task.id] ?? []} selected={selectedTaskId === task.id} onClick={() => selectTask(client, task.id, setSelectedTaskId, sendTaskWire)} />) : <Card.Content><Text tone="muted">No deliveries assigned to this project.</Text></Card.Content>}</Card>
          </section>
          <section className="grid gap-[var(--space-2)]">
            <SectionHead title="Slice tasks" count={slices.length} />
            <Card>{slices.length ? slices.map((task) => <TaskRow key={task.id} task={task} domains={domains} links={links[task.id] ?? []} selected={selectedTaskId === task.id} onClick={() => selectTask(client, task.id, setSelectedTaskId, sendTaskWire)} />) : <Card.Content><Text tone="muted">No slice tasks assigned to this project.</Text></Card.Content>}</Card>
          </section>
          <section className="grid gap-[var(--space-2)]">
            <SectionHead title="Unassigned tasks" count={unassignedTasks.length} />
            <Card>{unassignedTasks.length ? unassignedTasks.map((task) => <TaskRow key={task.id} task={task} domains={domains} links={links[task.id] ?? []} selected={selectedTaskId === task.id} onClick={() => selectTask(client, task.id, setSelectedTaskId, sendTaskWire)} />) : <Card.Content><Text tone="muted">No unassigned workflow tasks.</Text></Card.Content>}</Card>
          </section>
          {selectedTask && selectedDomain && <TaskDomainEditor client={client} task={selectedTask} domain={selectedDomain} projects={projects.filter((item) => item.archived_at_ms == null)} tasks={tasks} domains={domains} links={links[selectedTask.id] ?? []} onSave={saveDomain} onRefreshLinks={() => sendTaskWire(client, { type: 'task_tracker_links_get', task_id: selectedTask.id })} onOpenSession={onOpenSession} onError={setError} />}
        </>}
      </section>
    </div>}
  </PageFrame>
}

function selectTask(client: HoustonClient, id: number, setSelected: (id: number) => void, send: typeof sendTaskWire): void {
  setSelected(id)
  send(client, { type: 'task_tracker_links_get', task_id: id })
}

function ProjectEditor({ project, busy, onSave, onArchive }: { project: TaskProject; busy: boolean; onSave: (draft: { name: string; external_url: string | null; tracker_description: string | null; local_decisions: string[] }) => void; onArchive: () => void }): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [url, setUrl] = useState(project.external_url ?? '')
  const [decisions, setDecisions] = useState(project.local_decisions.join('\n'))
  useEffect(() => { setName(project.name); setUrl(project.external_url ?? ''); setDecisions(project.local_decisions.join('\n')) }, [project.id, project.revision])
  return <section className="grid gap-[var(--space-2)]" aria-label="Project details">
    <SectionHead title={project.name} />
    <Field label="Project name"><TextInput aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="External project URL"><TextInput aria-label="External project URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></Field>
    {project.project_external_id && <Text size="small" tone="muted">Tracker project ID: {project.project_external_id}</Text>}
    {project.tracker_description && <Notice tone="info">Imported tracker context — unverified. {project.tracker_description}</Notice>}
    <Field label="Local corrections and decisions"><TextArea aria-label="Local corrections and decisions" rows={4} value={decisions} onChange={(event) => setDecisions(event.target.value)} placeholder="One decision per line" /></Field>
    <div className="flex flex-wrap gap-[var(--space-2)]"><Button variant="primary" disabled={busy || name.trim() === ''} onClick={() => onSave({ name, external_url: url || null, tracker_description: project.tracker_description, local_decisions: decisions.split('\n').map((line) => line.trim()).filter(Boolean) })}>Save project</Button><Button variant="ghost" onClick={onArchive}>Archive project</Button></div>
  </section>
}

function TaskRow({ task, domains, links, selected, onClick }: { task: TaskSummary; domains: Record<number, TaskDomain>; links: TaskTrackerLink[]; selected: boolean; onClick: () => void }): React.JSX.Element {
  const domain = domains[task.id]
  const readiness = domain?.readiness
  const progress = domain?.kind === 'delivery' ? `${domain.slice_done}/${domain.slice_total} slices done` : null
  const sync = links.some((link) => link.sync_state.state === 'error') ? 'Sync error' : links.some((link) => link.sync_state.state === 'diverged') ? 'Diverged' : links.some((link) => link.sync_state.state === 'pending') ? 'Sync pending' : links.length ? 'In sync' : null
  return <Card.Row density="compact" className="gap-[var(--space-2)]" heading={<Button data-testid={`project-task-${task.id}`} variant="text" size="sm" aria-current={selected ? 'page' : undefined} onClick={onClick}>{task.title}</Button>} meta={[task.key, task.status, progress, readiness ? readiness.ready ? 'Ready' : `${readiness.reasons.length} readiness issues` : 'Readiness loading', sync].filter(Boolean).join(' · ')} />
}

function TaskDomainEditor({ client, task, domain, projects, tasks, domains, links, onSave, onRefreshLinks, onOpenSession, onError }: { client: HoustonClient; task: TaskSummary; domain: TaskDomain; projects: TaskProject[]; tasks: TaskSummary[]; domains: Record<number, TaskDomain>; links: TaskTrackerLink[]; onSave: (patch: { kind?: 'delivery' | 'slice'; project_id?: number | null; blocked_by?: number[] }) => void; onRefreshLinks: () => void; onOpenSession: (sessionId: number) => void; onError: (error: string | null) => void }): React.JSX.Element {
  const blockersText = domain.blocked_by.join(', ')
  const [blockers, setBlockers] = useState(blockersText)
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({})
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const [agent, setAgent] = useState<AgentKind>('claude')
  const manualStart = task.archived_at_ms == null && (task.status === 'backlog' || task.status === 'todo')
  useEffect(() => setBlockers(blockersText), [task.id, task.revision, blockersText])
  const plan = domain.plan
  const projectOptions = [{ value: '', label: 'No project' }, ...projects.map((item) => ({ value: String(item.id), label: item.name }))]
  const deliveryOptions = tasks.filter((item) => item.id !== task.id && item.workspace === task.workspace && item.status !== 'done' && domains[item.id]?.kind === 'delivery' && domains[item.id]?.project_id === domain.project_id).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.title}` }))
  return <Card className="grid gap-[var(--space-3)] p-[var(--space-3)]" aria-label="Task workflow">
    <SectionHead title={`${task.key} workflow`} />
    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <Select aria-label="Task kind" value={domain.kind} options={[{ value: 'delivery', label: 'Delivery' }, { value: 'slice', label: 'Slice task' }]} onChange={(value) => onSave({ kind: value as 'delivery' | 'slice' })} />
      <Select aria-label="Project" value={String(domain.project_id ?? '')} options={projectOptions} onChange={(value) => onSave({ project_id: value ? Number(value) : null })} />
      <Select aria-label="Agent" value={agent} options={(['claude', 'codex', 'opencode', 'cursor', 'grok'] as AgentKind[]).map((value) => ({ value, label: value }))} onChange={(value) => setAgent(value as AgentKind)} />
      {domain.kind === 'slice' && <Select aria-label="Delivery" value={task.parent_id == null ? '' : String(task.parent_id)} options={[{ value: '', label: 'No delivery' }, ...deliveryOptions]} onChange={(value) => client.taskSave(task.workspace, task.id, task.revision, { parent_id: value ? Number(value) : null })} />}
    </div>
    <div className="grid gap-[var(--space-2)]">
      <Field label="Blocked by task IDs"><TextInput aria-label="Blocked by task IDs" value={blockers} onChange={(event) => setBlockers(event.target.value)} placeholder="e.g. 12, 18" /><Button variant="secondary" onClick={() => {
        const ids = blockers.split(',').map((value) => value.trim()).filter(Boolean).map(Number)
        if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) { onError('Enter task IDs as positive whole numbers separated by commas.'); return }
        onSave({ blocked_by: [...new Set(ids)] })
      }}>Save blockers</Button></Field>
    </div>
    <div aria-live="polite" className="grid gap-[var(--space-1)]">
      <Text weight="semibold" tone={domain.readiness.ready ? 'success' : 'warning'}>{domain.readiness.ready ? 'Ready to start' : 'Not ready'}</Text>
      {!domain.readiness.ready && <ul className="list-disc pl-[var(--space-5)]">{domain.readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      <Text size="small" tone="muted">{domain.readiness.acceptance_verifiable} of {domain.readiness.acceptance_total} acceptance items are verifiable.</Text>
      {!domain.readiness.ready && manualStart && <Button variant="danger" onClick={() => sendTaskWire(client, { type: 'task_start', id: task.id, agent, workspace: task.workspace, override_readiness: true })}>Start anyway</Button>}
      {domain.readiness.ready && manualStart && <Button variant="primary" onClick={() => sendTaskWire(client, { type: 'task_start', id: task.id, agent, workspace: task.workspace, override_readiness: false })}>Start task</Button>}
    </div>
    {domain.planning_session_id != null && <Button variant="secondary" onClick={() => onOpenSession(domain.planning_session_id!)}>Open planning session</Button>}
    <Button variant="secondary" disabled={domain.planning_session_id != null} onClick={() => sendTaskWire(client, { type: 'task_plan_start', id: task.id, expected_revision: task.revision, agent })}>{domain.planning_session_id == null ? 'Generate plan' : 'Planning in progress'}</Button>
    {plan && <section className="grid gap-[var(--space-2)]" aria-label="Plan proposal">
      <SectionHead title="Plan proposal" />
      <Text as="p" className="whitespace-pre-wrap">{plan.proposal.description}</Text>
      <PlanList heading="Acceptance" items={plan.proposal.acceptance} />
      <PlanList heading="Pointers" items={plan.proposal.pointers} />
      <PlanList heading="Out of scope" items={plan.proposal.out_of_scope} />
      {plan.proposal.questions.map((question) => <div key={question} className="grid gap-[var(--space-1)]"><span>{question}</span><TextInput aria-label={`Answer: ${question}`} value={answerDrafts[question] ?? plan.answers.find((answer) => answer.question === question)?.answer ?? ''} onChange={(event) => setAnswerDrafts((current) => ({ ...current, [question]: event.target.value }))} /><Button variant="secondary" disabled={!(answerDrafts[question] ?? '').trim()} onClick={() => sendTaskWire(client, { type: 'task_plan_answer', id: task.id, expected_revision: task.revision, question, answer: answerDrafts[question].trim() })}>Save answer</Button></div>)}
      <Button variant="secondary" disabled={domain.readiness.unresolved_questions > 0 || domain.readiness.unresolved_tracker_conflicts > 0} onClick={() => sendTaskWire(client, { type: 'task_plan_approve', id: task.id, expected_revision: task.revision, plan_revision: plan.revision })}>{plan.approved_revision === task.revision ? 'Approved for this task revision' : 'Approve this plan revision'}</Button>
      {plan.approved_revision != null && plan.approved_revision !== task.revision && <Notice tone="warn">This approval is stale. Review and approve the current task revision.</Notice>}
    </section>}
    <Card className="grid gap-[var(--space-2)] p-[var(--space-2-5)]" aria-label="Tracker links">
      <SectionHead title="Tracker links" />
      <Button variant="secondary" onClick={onRefreshLinks}>Refresh links</Button>
      {links.length === 0 ? <Text tone="muted">No tracker links were returned for this task.</Text> : links.map((link) => <TrackerLinkRow key={`${link.provider}:${link.external_id}`} link={link} customValue={customValues[`${link.provider}:${link.external_id}`] ?? ''} onCustom={(value) => setCustomValues((current) => ({ ...current, [`${link.provider}:${link.external_id}`]: value }))} onResolve={(field, resolution) => sendTaskWire(client, { type: 'task_tracker_conflict_resolve', task_id: task.id, provider: link.provider, external_id: link.external_id, field, expected_revision: link.snapshot.revision, resolution })} />)}
    </Card>
  </Card>
}

function PlanList({ heading, items }: { heading: string; items: string[] }): React.JSX.Element | null {
  if (!items.length) return null
  return <div><Text weight="semibold">{heading}</Text><ul className="list-disc pl-[var(--space-5)]">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
}

function TrackerLinkRow({ link, customValue, onCustom, onResolve }: { link: TaskTrackerLink; customValue: string; onCustom: (value: string) => void; onResolve: (field: string, resolution: { kind: 'local' | 'remote' } | { kind: 'custom'; value: string }) => void }): React.JSX.Element {
  const state = link.sync_state.state === 'error' ? `Error: ${link.sync_state.message}` : link.sync_state.state === 'diverged' ? 'Diverged' : link.sync_state.state === 'pending' ? 'Sync pending' : 'In sync'
  const sourceLabel = linkIsPullRequest(link) ? 'Pull request' : 'Source link'
  return <Card padding="sm" className="grid gap-[var(--space-2)]">
    <div className="flex flex-wrap items-center gap-[var(--space-2)]"><InlineLink href={link.url}>{sourceLabel} · {link.external_id}</InlineLink><Text size="small" tone={link.sync_state.state === 'error' ? 'danger' : 'muted'}>{state}</Text></div>
    {link.snapshot.project && <Notice tone="info">Imported project context — unverified. {link.snapshot.project.title}: {link.snapshot.project.description} <InlineLink href={link.snapshot.project.url}>Open project</InlineLink></Notice>}
    {!link.snapshot.project && link.snapshot.project_external_id && <Text size="small" tone="muted">External project ID {link.snapshot.project_external_id} has not been matched to a local project.</Text>}
    {link.snapshot.conflicts.map((conflict) => <Card key={conflict.field} tone="inset" padding="sm" className="grid gap-[var(--space-1)]">
      <Text weight="semibold">{conflict.field} conflict</Text><Text>Houston: {conflict.local || '—'}</Text><Text>Tracker: {conflict.remote || '—'}</Text>
      <div className="flex flex-wrap gap-[var(--space-2)]"><Button variant="secondary" onClick={() => onResolve(conflict.field, { kind: 'local' })}>Keep Houston value</Button><Button variant="secondary" onClick={() => onResolve(conflict.field, { kind: 'remote' })}>Use tracker value</Button></div>
      <Field label="Custom resolution"><TextInput aria-label={`Custom ${conflict.field} value`} value={customValue} onChange={(event) => onCustom(event.target.value)} /><Button variant="secondary" disabled={!customValue.trim()} onClick={() => onResolve(conflict.field, { kind: 'custom', value: customValue })}>Use custom value</Button></Field>
    </Card>)}
  </Card>
}

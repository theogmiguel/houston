import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { HoustonClient } from '../../houston/client'
import type { TaskDetailData } from '../../houston/useTasks'
import { sendTaskWire, type TaskDomain, type TaskProject } from '../../houston/taskDomain'
import { BulletList, Button, Card, Field, Inline, Notice, SectionHead, Select, Text, TextInput } from '../ui'

export function TaskWorkflowPanel({ client, detail, onOpenSession, onStartRequested }: {
  client: Pick<HoustonClient, 'subscribeAll' | 'taskSnapshot' | 'taskSave' | 'send'>
  detail: TaskDetailData
  onOpenSession: (id: number) => void
  onStartRequested?: (taskId: number, workspace: string) => void
}): React.JSX.Element {
  const { task } = detail
  const workspace = task.workspace
  const [domain, setDomain] = useState<TaskDomain | null>(null)
  const [projects, setProjects] = useState<TaskProject[]>([])
  const [workspaceTasks, setWorkspaceTasks] = useState<TaskSummary[]>([])
  const [domains, setDomains] = useState<Record<number, TaskDomain>>({})
  const [blockers, setBlockers] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const onOpenSessionRef = useRef(onOpenSession)
  onOpenSessionRef.current = onOpenSession

  useEffect(() => {
    setDomain(null)
    setProjects([])
    setWorkspaceTasks([])
    setDomains({})
    setError(null)
    const off = client.subscribeAll((message) => {
      if (message.type === 'task_domain_state' && message.domain.task_id === task.id) {
        setDomain(message.domain)
        setBlockers(message.domain.blocked_by.join(', '))
      }
      if (message.type === 'task_domain_state') setDomains((current) => ({ ...current, [message.domain.task_id]: message.domain }))
      if (message.type === 'task_projects_state' && message.workspace === task.workspace) setProjects(message.projects)
      if (message.type === 'task_snapshot' && message.scope === task.workspace) {
        setWorkspaceTasks(message.tasks)
        message.tasks.forEach((item) => sendTaskWire(client, { type: 'task_domain_get', id: item.id }))
      }
      if (message.type === 'task_plan_started' && message.id === task.id) onOpenSessionRef.current(message.session_id)
      if (message.type === 'task_plan_changed' && message.id === task.id) sendTaskWire(client, { type: 'task_domain_get', id: task.id })
    })
    sendTaskWire(client, { type: 'task_domain_get', id: task.id })
    if (workspace) {
      sendTaskWire(client, { type: 'task_projects_list', workspace })
      client.taskSnapshot(workspace)
    }
    return off
  }, [client, task.id, workspace])

  if (!workspace) return <Text tone="muted">Assign a workspace before editing project workflow.</Text>
  if (!domain) return <Text role="status" aria-busy="true" tone="muted">Loading project workflow…</Text>

  const save = (patch: { kind?: 'delivery' | 'slice'; project_id?: number | null; blocked_by?: number[] }): void => sendTaskWire(client, {
    type: 'task_domain_save', id: task.id, expected_revision: task.revision, ...patch
  })
  const manualStart = task.archived_at_ms == null && (task.status === 'backlog' || task.status === 'todo')
  const startAnyway = (): void => {
    onStartRequested?.(task.id, workspace)
    sendTaskWire(client, { type: 'task_start', id: task.id, workspace, agent, override_readiness: true })
  }
  const plan = domain.plan
  // The current parent stays listed even when it is no longer an open delivery of this project.
  const deliveryOptions = workspaceTasks.filter((item) => item.id !== task.id && item.workspace === workspace && (item.id === task.parent_id || (item.status !== 'done' && domains[item.id]?.kind === 'delivery' && domains[item.id]?.project_id === domain.project_id))).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.title}` }))

  return <Card padding="sm" className="grid gap-[var(--space-2)]" aria-label="Project workflow">
    <SectionHead title="Project workflow" />
    {error && <Notice tone="danger">{error}</Notice>}
    <Inline wrap gap="small">
      <Select aria-label="Task kind" value={domain.kind} options={[{ value: 'delivery', label: 'Delivery' }, { value: 'slice', label: 'Slice task' }]} onChange={(value) => save({ kind: value as 'delivery' | 'slice' })} />
      <Select aria-label="Project" value={domain.project_id == null ? '' : String(domain.project_id)} options={[{ value: '', label: 'No project' }, ...projects.filter((project) => project.archived_at_ms == null).map((project) => ({ value: String(project.id), label: project.name }))]} onChange={(value) => save({ project_id: value ? Number(value) : null })} />
      {domain.kind === 'slice' && <Select aria-label="Delivery" value={task.parent_id == null ? '' : String(task.parent_id)} options={[{ value: '', label: 'No delivery' }, ...deliveryOptions]} onChange={(value) => client.taskSave(workspace, task.id, task.revision, { parent_id: value ? Number(value) : null })} />}
      <Select aria-label="Planning and implementation agent" value={agent} options={(['claude', 'codex', 'opencode', 'cursor', 'grok', 'zcode'] as AgentKind[]).map((value) => ({ value, label: value }))} onChange={(value) => setAgent(value as AgentKind)} />
    </Inline>
    <Field label="Blocked by task IDs"><div className="grid gap-[var(--space-2)]"><TextInput aria-label="Blocked by task IDs" value={blockers} onChange={(event) => setBlockers(event.target.value)} placeholder="Comma-separated task IDs" /><Button variant="secondary" onClick={() => {
      const ids = blockers.split(',').map((value) => value.trim()).filter(Boolean).map(Number)
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) { setError('Enter positive whole-number task IDs separated by commas.'); return }
      setError(null)
      save({ blocked_by: [...new Set(ids)] })
    }}>Save blockers</Button></div></Field>
    <WorkflowReadiness domain={domain} manualStart={manualStart} onStartAnyway={startAnyway} />
    <Button variant="secondary" disabled={domain.planning_session_id != null} onClick={() => sendTaskWire(client, { type: 'task_plan_start', id: task.id, expected_revision: task.revision, agent })}>{domain.planning_session_id == null ? 'Generate plan' : 'Planning in progress'}</Button>
    {domain.planning_session_id != null && <Button variant="secondary" onClick={() => onOpenSession(domain.planning_session_id!)}>Open planning session</Button>}
    <WorkflowPlan client={client} detail={detail} domain={domain} plan={plan} answers={answers} setAnswers={setAnswers} />
  </Card>
}

function WorkflowReadiness({ domain, manualStart, onStartAnyway }: {
  domain: TaskDomain
  manualStart: boolean
  onStartAnyway: () => void
}): React.JSX.Element {
  return <div aria-live="polite" className="grid gap-[var(--space-1)]">
    <Text weight="semibold" tone={domain.readiness.ready ? 'success' : 'warning'}>{domain.readiness.ready ? 'Ready to start' : 'Not ready'}</Text>
    {!domain.readiness.ready && <BulletList items={domain.readiness.reasons} />}
    <Text size="small" tone="muted">{domain.readiness.acceptance_verifiable} of {domain.readiness.acceptance_total} acceptance items are verifiable.</Text>
    {!domain.readiness.ready && manualStart && <Button variant="danger" onClick={onStartAnyway}>Start anyway</Button>}
  </div>
}

function WorkflowPlan({ client, detail, domain, plan, answers, setAnswers }: {
  client: Pick<HoustonClient, 'send'>
  detail: TaskDetailData
  domain: TaskDomain
  plan: TaskDomain['plan']
  answers: Record<string, string>
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>
}): React.JSX.Element | null {
  if (!plan) return null
  const { task } = detail

  return <Card padding="sm" className="grid gap-[var(--space-2)]" aria-label="Plan proposal">
    <SectionHead title="Plan proposal" />
    <Text as="p" preserveWhitespace>{plan.proposal.description}</Text>
    <ProposalList heading="Acceptance" items={plan.proposal.acceptance} />
    <ProposalList heading="Pointers" items={plan.proposal.pointers} />
    <ProposalList heading="Out of scope" items={plan.proposal.out_of_scope} />
    {plan.proposal.questions.map((question) => <div key={question} className="grid gap-[var(--space-1)]"><span>{question}</span><TextInput aria-label={`Answer: ${question}`} value={answers[question] ?? plan.answers.find((item) => item.question === question)?.answer ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question]: event.target.value }))} /><Button variant="secondary" disabled={!(answers[question] ?? '').trim()} onClick={() => sendTaskWire(client, { type: 'task_plan_answer', id: task.id, expected_revision: task.revision, question, answer: answers[question].trim() })}>Save answer</Button></div>)}
    <Button variant="secondary" disabled={domain.readiness.unresolved_questions > 0 || domain.readiness.unresolved_tracker_conflicts > 0} onClick={() => sendTaskWire(client, { type: 'task_plan_approve', id: task.id, expected_revision: task.revision, plan_revision: plan.revision })}>{plan.approved_revision === task.revision ? 'Approved for this task revision' : 'Approve this plan revision'}</Button>
    {plan.approved_revision != null && plan.approved_revision !== task.revision && <Notice tone="warn">This approval is stale. Review and approve the current task revision.</Notice>}
  </Card>
}

function ProposalList({ heading, items }: { heading: string; items: string[] }): React.JSX.Element | null {
  return items.length ? <div><Text weight="semibold">{heading}</Text><BulletList items={items} /></div> : null
}

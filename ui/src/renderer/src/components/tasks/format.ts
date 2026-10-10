import type { AgentKind } from '../../houston/generated/AgentKind'
import type { TaskComment } from '../../houston/generated/TaskComment'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunKind } from '../../houston/generated/TaskRunKind'
import type { TaskRunState } from '../../houston/generated/TaskRunState'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { isPullRequestUrl } from '../../houston/taskDomain'
import { TASK_TITLE_MAX } from '../../houston/generated/DEFAULTS'

// The Tasks tab order, highest first: active work, then the queue, then the
// settled tail. Mirrors the approved mock's group order; `canceled` closes it
// because slice 1 stores a status the mock predates.
export const STATUS_ORDER: readonly TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'canceled'
]

export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  in_progress: 'In progress',
  in_review: 'In review',
  todo: 'Todo',
  backlog: 'Backlog',
  done: 'Done',
  canceled: 'Canceled'
}

export const STATUS_COLLAPSED_BY_DEFAULT: ReadonlySet<TaskStatus> = new Set(['done', 'canceled'])

export const PRIORITY_LABEL: Readonly<Record<TaskPriority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None'
}

// urgent > high > medium > low > none, then updated desc.
const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
}

export function compareTasks(a: TaskSummary, b: TaskSummary): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  if (a.updated_at_ms !== b.updated_at_ms) return b.updated_at_ms - a.updated_at_ms
  return b.number - a.number
}

/// The daemon's ready order — priority, then oldest number first — so the
/// roster queue previews the same tasks `task_queue_run` picks, in that order.
export function compareReadyTasks(a: TaskSummary, b: TaskSummary): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  return byPriority !== 0 ? byPriority : a.number - b.number
}

/// The snapshot's todo pool in the daemon's start order. The wire has no
/// per-task blocker flag, so a blocked todo task looks ready here; the queue
/// labels the pool with the real `TaskCounts.ready`.
export function queuePreview(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks
    .filter((task) => task.archived_at_ms == null && task.status === 'todo' && task.open_run == null)
    .sort(compareReadyTasks)
}

/// How many tasks "Run next N" asks for: the ready pool, capped by the free
/// child slots under the orchestration cap. A null cap (state not loaded) is
/// no answer, not an unlimited one.
export function runNextCount(ready: number, live: number, cap: number | null): number {
  if (cap === null) return 0
  return Math.max(0, Math.min(ready, Math.max(0, cap - live)))
}

/// Why "Run next N" is disabled, naming the limit it hit. Null when it can run.
export function runNextDisabledReason(ready: number, live: number, cap: number | null): string | null {
  if (cap === null) return 'Orchestration caps are not loaded yet'
  if (ready === 0) return 'No ready tasks'
  if (cap - live <= 0) {
    return `No free child slot: ${live} live child(ren) against the cap of ${cap} (Settings ▸ Orchestration)`
  }
  return null
}

export type TaskGroupKey = TaskStatus | 'archived'

export interface TaskGroup {
  key: TaskGroupKey
  label: string
  tasks: TaskSummary[]
}

export type QueueGroupKey = 'your-turn' | 'working' | 'stopped' | 'up-next' | 'done' | 'archived'
export type QueueAction = 'Answer' | 'Open PR' | 'Open pane' | 'Start again' | 'Start' | 'Review changes'

export interface QueueGroup {
  key: QueueGroupKey
  label: string
  tasks: TaskSummary[]
}

export function queueGroupOf(task: TaskSummary): QueueGroupKey | null {
  if (task.archived_at_ms != null) return 'archived'
  if (task.status === 'done') return 'done'
  if (task.status === 'canceled') return 'stopped'
  if (task.open_question) return 'your-turn'
  if (task.open_run?.state === 'waiting_for_input') return 'your-turn'
  if (task.status === 'in_review') return 'your-turn'
  if (task.open_run != null && ['preparing', 'running', 'validating'].includes(task.open_run.state)) return 'working'
  if (task.status === 'in_progress') return 'stopped'
  if (task.status === 'todo' || task.status === 'backlog') return 'up-next'
  return null
}

export function queueActionOf(task: TaskSummary): QueueAction {
  if (task.open_question || task.open_run?.state === 'waiting_for_input') return 'Answer'
  if (task.status === 'in_review') return task.open_run?.pr_url && isPullRequestUrl(task.open_run.pr_url) ? 'Open PR' : 'Review changes'
  if (task.open_run?.session_id != null) return 'Open pane'
  if (task.status === 'in_progress' || task.status === 'canceled') return 'Start again'
  return 'Start'
}

// A Slack-filed task waiting to start says why: for the owner's ✅, or for a
// working slot with its place in the queue.
export function intakeLabel(task: Pick<TaskSummary, 'intake' | 'open_run'>): string | null {
  const intake = task.intake
  if (!intake || task.open_run) return null
  if (intake.state === 'pending') return 'Slack · awaiting ✅'
  if (intake.state === 'queued') return `Slack · queued #${intake.queue_position ?? '?'}`
  return null
}

export const FINISHED_GROUP_LABEL = 'Done and Archived'

export function queueGroups(tasks: readonly TaskSummary[]): QueueGroup[] {
  const definitions: readonly [QueueGroupKey, string][] = [
    ['your-turn', 'Your turn'],
    ['working', 'Agents working'],
    ['stopped', 'Stopped'],
    ['up-next', 'Up next']
  ]
  const groups: QueueGroup[] = definitions.map(([key, label]) => ({
    key,
    label,
    tasks: tasks.filter((task) => queueGroupOf(task) === key).sort(compareTasks)
  })).filter((group) => group.tasks.length > 0)
  const done = tasks.filter((task) => queueGroupOf(task) === 'done').sort(compareTasks)
  const archived = tasks.filter((task) => queueGroupOf(task) === 'archived').sort(compareTasks)
  if (done.length + archived.length > 0) groups.push({ key: 'done', label: FINISHED_GROUP_LABEL, tasks: [...done, ...archived] })
  return groups
}

const ARCHIVED_LABEL = 'Archived'

/// Non-empty groups only, in display order. Archived tasks leave their status
/// group because restoring them is a different act than working them; slice 1
/// keeps them in the snapshot so the UI can offer that restore.
export function groupTasks(tasks: readonly TaskSummary[]): TaskGroup[] {
  const active = tasks.filter((t) => t.archived_at_ms == null)
  const archived = tasks.filter((t) => t.archived_at_ms != null)
  const groups: TaskGroup[] = []
  for (const status of STATUS_ORDER) {
    const inStatus = active.filter((t) => t.status === status).sort(compareTasks)
    if (inStatus.length > 0) groups.push({ key: status, label: STATUS_LABEL[status], tasks: inStatus })
  }
  if (archived.length > 0) {
    groups.push({ key: 'archived', label: ARCHIVED_LABEL, tasks: [...archived].sort(compareTasks) })
  }
  return groups
}

/// Compact age, the same vocabulary the mock's `.tk-age` uses: now, 8m, 3h, 2d.
export function formatAge(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function formatAgo(atMs: number, nowMs: number): string {
  const age = formatAge(atMs, nowMs)
  return age === 'now' ? 'just now' : `${age} ago`
}

export const READ_ONLY_REASON =
  'Tasks are read-only for this workspace — change Settings ▸ Tasks ▸ Agent access'

/// `user` is whoever is reading; the daemon's derived actors all read as
/// Houston, and an agent provenance string renders as its codename with the
/// role dropped from the sentence.
export function actorLabel(actor: string): string {
  if (actor === 'user') return 'You'
  if (actor.startsWith('houston:')) return 'Houston'
  if (actor.startsWith('agent:')) return actor.slice('agent:'.length).split(' (')[0] || actor
  return actor
}

// A run's tone picks the dot and label colors the mock reserves for each
// state: Needs you is the todo text, Working the doing text, Handed back done,
// and a failed run the blocked text.
export type RunTone = 'spawning' | 'working' | 'needs' | 'idle' | 'done' | 'failed'

/// Whether the run still holds its pane: Stop is legal, Resume is not.
export function runIsOpen(state: TaskRunState): boolean {
  switch (state) {
    case 'preparing':
    case 'running':
    case 'waiting_for_input':
    case 'validating':
      return true
    default:
      return false
  }
}

/// The state label the row, chip tooltip and execution card share. A failed
/// review run says Review failed, the mock's wording; an implementation run
/// that never got off the ground says Failed.
export function runStateLabel(state: TaskRunState, kind?: TaskRunKind): string {
  switch (state) {
    case 'preparing':
      return 'Preparing'
    case 'running':
      return 'Working'
    case 'waiting_for_input':
      return 'Needs you'
    case 'validating':
      return 'Validating'
    case 'handed_back':
      return 'Handed back'
    case 'needs_review':
      return 'Needs review'
    case 'failed':
      return kind === 'review' ? 'Review failed' : 'Failed'
    case 'cancelled':
      return 'Stopped'
    case 'interrupted':
      return 'Interrupted'
    default:
      return humanizeState(state)
  }
}

/// The Now card's label: the task status while the run is in flight (the mock
/// shows "In progress · derived from pane status"), "Needs you" when the pane
/// waits for input, and the run's own label once it is no longer open.
export function nowRunLabel(state: TaskRunState | null, status: TaskStatus): string | null {
  if (state === null) return null
  if (state === 'waiting_for_input') return 'Needs you'
  if (runIsOpen(state)) return STATUS_LABEL[status]
  return runStateLabel(state)
}

export function runStateTone(state: TaskRunState): RunTone {
  switch (state) {
    case 'preparing':
      return 'spawning'
    case 'running':
    case 'validating':
      return 'working'
    case 'waiting_for_input':
    case 'needs_review':
    case 'interrupted':
      return 'needs'
    case 'handed_back':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return 'idle'
  }
}

function humanizeState(state: string): string {
  return state
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// The providers a task can start with, in the composer's order. Slice 3's
// Start has no base-branch choice yet; the daemon admits exactly these six.
export const TASK_AGENTS: readonly AgentKind[] = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'cursor',
  'grok'
]

const TASK_AGENT_LABEL: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok'
}

export function taskAgentLabel(agent: AgentKind): string {
  return TASK_AGENT_LABEL[agent] ?? agent
}

/// One line naming what a history update moved, from the stored JSON diff.
export function describeTaskChanges(changes: string): string {
  try {
    const parsed = JSON.parse(changes) as Record<string, unknown>
    const keys = Object.keys(parsed)
    const labels = keys.map((key) => CHANGE_LABEL[key] ?? key)
    if (labels.length === 0) return 'this task'
    if (labels.length === 1) return labels[0]
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  } catch {
    return 'this task'
  }
}

const CHANGE_LABEL: Readonly<Record<string, string>> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  parent_id: 'parent',
  ref_url: 'link',
  acceptance: 'acceptance'
}

export interface HistoryLine {
  verb: string
  detail?: string
  /// A derived move's provenance, rendered as the mock's FROM PANE STATUS mark.
  system?: string
}

/// The activity verb for one history row (callers skip `comment` rows: the
/// comment itself carries them). `runs` resolves a run id to its attempt
/// number; without it the sentence stays true but loses the number.
export function historyLine(entry: TaskHistoryEntry, runs: readonly TaskRun[] = []): HistoryLine | null {
  switch (entry.action) {
    case 'create':
      return { verb: 'created this task' }
    case 'update':
      return { verb: `updated ${describeTaskChanges(entry.changes)}` }
    case 'comment':
      return null
    case 'check':
      return { verb: 'checked an acceptance item', detail: quoteItem(entry.changes) }
    case 'uncheck':
      return { verb: 'unchecked an acceptance item', detail: quoteItem(entry.changes) }
    case 'archive':
      return { verb: 'archived this task' }
    case 'restore':
      return { verb: 'restored this task' }
    case 'claim':
      return { verb: 'claimed this task' }
    case 'handback':
      return { verb: 'moved to In review' }
    case 'start':
      return { verb: attemptVerb('started', entry.changes, runs) }
    case 'resume':
      return { verb: attemptVerb('resumed', entry.changes, runs) }
    case 'pane_working':
      return { verb: 'moved to In progress', system: 'from pane status' }
    case 'pr_merged':
      return { verb: 'moved to Done', system: 'pull request merged' }
    default:
      return { verb: entry.action.replace(/_/g, ' ') }
  }
}

function attemptVerb(verb: string, changes: string, runs: readonly TaskRun[]): string {
  const id = runIdFromChanges(changes)
  const run = id === null ? undefined : runs.find((candidate) => candidate.id === id)
  return run ? `${verb} attempt ${run.attempt}` : `${verb} a run`
}

function runIdFromChanges(changes: string): number | null {
  try {
    const value = (JSON.parse(changes) as { run?: unknown }).run
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

function quoteItem(changes: string): string | undefined {
  try {
    const text = (JSON.parse(changes) as { text?: unknown }).text
    return typeof text === 'string' ? `“${text}”` : undefined
  } catch {
    return undefined
  }
}

export function acceptanceText(checked: number, total: number): string {
  return `${checked} / ${total}`
}

export interface ReworkRoundsCheck {
  value: number | null
  error: string | null
}

/// The Automatic rework rounds field's guard: whole numbers only, in
/// `0..max`. A bad draft is refused with the limit, the requested value and
/// the value the setting keeps, and never reaches the daemon.
export function parseReworkRounds(raw: string, current: number, max: number): ReworkRoundsCheck {
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (trimmed === '' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      value: null,
      error: `Rework rounds must be a whole number between 0 and ${max} — got “${raw}” (currently ${current})`
    }
  }
  if (value < 0 || value > max) {
    return {
      value: null,
      error: `Rework rounds ${value} is outside 0..${max} — the requested value was refused and the setting kept ${current}`
    }
  }
  return { value, error: null }
}

/// The palette's "New task from terminal selection": the selection is the
/// description, its first line the title, truncated to the daemon's title cap.
export function taskDraftFromSelection(selection: string): { title: string; description: string } | null {
  const description = selection.trim()
  if (description === '') return null
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const title = [...firstLine].slice(0, TASK_TITLE_MAX).join('')
  return { title, description }
}

/// The reviewer a task's runs name: the newest review run's own provider, or
/// the implementation run's configured reviewer before a review has run.
export function taskReviewer(runs: readonly TaskRun[]): AgentKind | null {
  return (
    runs.find((run) => run.kind === 'review')?.provider ??
    runs.find((run) => run.kind === 'implementation')?.reviewer ??
    null
  )
}

export type ReviewVerdict = 'pass' | 'fail' | 'needs_review'

export interface TaskReviewOutcome {
  reviewer: AgentKind
  verdict: ReviewVerdict
  /// The reviewer's rendered findings, from the review run's summary or the
  /// newest verdict comment. Null when there is nothing to show.
  findings: string | null
  /// The closed implementation run a "Retry with findings" would open attempt
  /// N+1 for; null while no retryable run exists.
  retryRunId: number | null
}

/// Review facts for the execution card and properties row: reviewer, verdict
/// and the findings a retry would attach. Runs are newest first; an open run or
/// a reviewer that never reported has no verdict.
export function taskReviewOutcome(
  runs: readonly TaskRun[],
  comments: readonly TaskComment[]
): TaskReviewOutcome | null {
  const newest = runs[0]
  if (!newest) return null
  if (newest.kind === 'implementation' && runIsOpen(newest.state)) return null
  const reviewRun = runs.find((run) => run.kind === 'review') ?? null
  const implRun = runs.find((run) => run.kind === 'implementation') ?? null
  const reviewer = taskReviewer(runs)
  if (reviewer == null) return null
  let verdict: ReviewVerdict | null = null
  if (reviewRun && !runIsOpen(reviewRun.state)) {
    if (reviewRun.state === 'handed_back') verdict = 'pass'
    else if (reviewRun.state === 'needs_review' || reviewRun.state === 'failed') verdict = 'fail'
  }
  if (verdict === null && implRun?.state === 'needs_review') {
    verdict = failedReviewFindings(comments) !== null ? 'fail' : 'needs_review'
  }
  if (verdict === null) return null
  const findings = reviewRun?.summary?.trim() || failedReviewFindings(comments)
  const retryRunId = implRun != null && implRun.state === 'needs_review' ? implRun.id : null
  return { reviewer, verdict, findings: findings === '' ? null : findings, retryRunId }
}

/// The findings body of the newest failed review comment, which the daemon
/// writes as `Review verdict: fail` then the rendered findings.
function failedReviewFindings(comments: readonly TaskComment[]): string | null {
  let newest: TaskComment | null = null
  for (const comment of comments) {
    if (!comment.body.startsWith('Review verdict: fail')) continue
    if (newest === null || comment.created_at_ms > newest.created_at_ms) newest = comment
  }
  if (newest === null) return null
  const findings = newest.body.split(/\r?\n/).slice(1).join('\n').trim()
  return findings === '' ? null : findings
}

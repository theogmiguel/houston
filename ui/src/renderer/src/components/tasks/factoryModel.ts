import type { InboxRow } from '../../houston/generated/InboxRow'
import type { SessionInfo } from '../../houston/client'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { isPullRequestUrl } from '../../houston/taskDomain'
import { compareReadyTasks, intakeLabel } from './format'
import { questionFor } from './needsInput'
import type { TaskQuestion } from './TaskQuestionCard'

export type NeedsYouItem =
  | { kind: 'question'; task: TaskSummary; question: TaskQuestion; at: number }
  | { kind: 'input'; task: TaskSummary; text: string | null; sessionId: number | null; at: number }
  | { kind: 'review'; task: TaskSummary; at: number }

// Landing keeps a done task this long, so a merge stays visible for a while.
export const LANDING_DONE_WINDOW_MS = 7 * 24 * 60 * 60_000

const LIVE_STATES: ReadonlySet<string> = new Set(['preparing', 'running', 'validating'])

function active(task: TaskSummary): boolean {
  return task.archived_at_ms == null && task.status !== 'done' && task.status !== 'canceled'
}

/** One item per task that waits on the user, oldest first: a question, a run waiting for input, or a result in review. */
export function needsYouItems(tasks: readonly TaskSummary[], sessions: ReadonlyMap<number, SessionInfo>, rows: InboxRow[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const task of tasks) {
    if (!active(task)) continue
    if (task.open_question) {
      items.push({ kind: 'question', task, question: task.open_question, at: task.open_question.created_at_ms })
    } else if (task.open_run?.state === 'waiting_for_input') {
      const sessionId = task.open_run.session_id ?? null
      const since = sessionId == null ? null : sessions.get(sessionId)?.status_since_ms ?? null
      items.push({ kind: 'input', task, text: questionFor(task, sessions, rows), sessionId, at: since ?? task.updated_at_ms })
    } else if (task.status === 'in_review') {
      items.push({ kind: 'review', task, at: task.updated_at_ms })
    }
  }
  return items.sort((a, b) => a.at - b.at || a.task.id - b.task.id)
}

/** Tasks whose run is live and not waiting on the user, longest running first. */
export function workingTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks
    .filter((task) => task.archived_at_ms == null && !task.open_question && task.open_run != null && LIVE_STATES.has(task.open_run.state))
    .sort((a, b) => a.open_run!.started_at_ms - b.open_run!.started_at_ms)
}

/** Slack requests that wait for the owner's approval or for a slot. */
export function slackWaiting(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks
    .filter((task) => task.archived_at_ms == null && intakeLabel(task) !== null)
    .sort((a, b) => a.created_at_ms - b.created_at_ms)
}

/** Todo tasks no run has opened and no Slack intake holds back. */
export function readyBacklog(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks
    .filter((task) => task.archived_at_ms == null && task.status === 'todo' && task.open_run == null && !task.open_question && intakeLabel(task) === null)
    .sort(compareReadyTasks)
}

/** Tasks in review, or done within the window, that recorded a pull request; newest first. */
export function landingTasks(tasks: readonly TaskSummary[], now: number): TaskSummary[] {
  return tasks
    .filter((task) => task.archived_at_ms == null && (task.pr_number != null || pullRequestUrlOf(task) !== null))
    .filter((task) => task.status === 'in_review' || (task.status === 'done' && now - task.updated_at_ms <= LANDING_DONE_WINDOW_MS))
    .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
}

export function pullRequestUrlOf(task: TaskSummary): string | null {
  const url = task.pr_url ?? task.open_run?.pr_url ?? null
  return url && isPullRequestUrl(url) ? url : null
}

export function pullRequestNumberOf(task: TaskSummary): number | null {
  if (task.pr_number != null) return task.pr_number
  const match = pullRequestUrlOf(task)?.match(/\/pull\/(\d+)(?:\/|[?#]|$)/)?.[1]
  return match ? Number(match) : null
}

/** What the agent is doing, as the hook reported it: its last message, else the prompt it is working on. */
export function activityPhrase(session: SessionInfo | undefined): string | null {
  return session?.activity?.last_message?.trim() || session?.activity?.prompt?.trim() || null
}

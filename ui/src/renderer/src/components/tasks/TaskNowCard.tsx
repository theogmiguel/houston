import type { SessionInfo } from '../../houston/client'
import type { TaskAcceptanceItem } from '../../houston/generated/TaskAcceptanceItem'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunState } from '../../houston/generated/TaskRunState'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TaskDetailData } from '../../houston/useTasks'
import { Icon } from '../ui/Icon'
import { IconCheck, IconGitBranch } from '../icons'
import {
  TaskAgentTag,
  TaskBody,
  TaskButton,
  TaskCardActions,
  TaskCheckRow,
  TaskDot,
  TaskKeyTag,
  TaskNowLabel,
  TaskNowMeta,
  TaskNowSection,
  TaskNowShell,
  TaskNowTitle,
  TaskStateText,
  TaskTagChip
} from '../ui'
import { acceptanceText, nowRunLabel, runIsOpen, runStateTone, taskAgentLabel } from './format'
import { TaskStatusGlyph } from './glyphs'

function NowRunMeta({
  state,
  status,
  openRun
}: {
  state: TaskRunState | null
  status: TaskStatus
  openRun: TaskRun | null
}): React.JSX.Element {
  return (
    <>
      {state !== null && (
        <>
          <TaskDot tone={runStateTone(state)} />
          <TaskStateText tone={runStateTone(state)}>{nowRunLabel(state, status)}</TaskStateText>
          <span>derived from pane status</span>
        </>
      )}
      {openRun && <TaskAgentTag agent={openRun.provider} label={taskAgentLabel(openRun.provider)} />}
      {openRun?.branch != null && (
        <TaskTagChip>
          <Icon glyph={IconGitBranch} role="small" />
          <span className="truncate">{openRun.branch}</span>
        </TaskTagChip>
      )}
    </>
  )
}

function NowAcceptance({
  acceptance,
  summary
}: {
  acceptance: readonly TaskAcceptanceItem[]
  summary: TaskSummary | null
}): React.JSX.Element | null {
  if (acceptance.length === 0) {
    if (!summary) return null
    return (
      <TaskNowSection>
        <TaskBody>acceptance {acceptanceText(summary.acceptance_checked, summary.acceptance_total)}</TaskBody>
      </TaskNowSection>
    )
  }
  return (
    <TaskNowSection>
      {acceptance.map((item) => (
        <TaskCheckRow
          key={item.id}
          dense
          checked={item.checked_at_ms != null}
          mark={<Icon glyph={IconCheck} role="small" />}
          text={item.text}
        />
      ))}
    </TaskNowSection>
  )
}

// The focused pane's task, pinned above the grouped list (mock `sideNow`).
// The run's provider and branch come from the snapshot's open run; acceptance
// items come from the watched detail, with the snapshot's count as fallback.
export function TaskNowCard({
  session,
  summary,
  detail,
  onOpenSession,
  onStop
}: {
  session: SessionInfo
  summary: TaskSummary | null
  detail: TaskDetailData | null
  onOpenSession: (sessionId: number) => void
  onStop: (runId: number) => void
}): React.JSX.Element | null {
  const task = session.task
  if (!task) return null
  const openRun = summary?.open_run ?? null
  const state: TaskRunState | null = summary ? openRun?.state ?? null : task.run_state
  const acceptance = detail?.task.id === task.task_id ? detail.acceptance : []
  const showStop = state !== null && runIsOpen(state)

  return (
    <TaskNowShell data-testid="tasks-now">
      <TaskNowLabel label="Now · focused pane" trailing={session.codename} />
      <TaskNowTitle>{summary?.title ?? task.title}</TaskNowTitle>
      <TaskNowMeta>
        <TaskKeyTag data-testid="tasks-now-key">
          <TaskStatusGlyph status={summary?.status ?? task.status} />
          {task.key}
        </TaskKeyTag>
        <NowRunMeta state={state} status={summary?.status ?? task.status} openRun={openRun} />
      </TaskNowMeta>
      <NowAcceptance acceptance={acceptance} summary={summary} />
      <TaskNowSection>
        <TaskCardActions inset={false}>
          <TaskButton
            tone="primary"
            data-testid="tasks-now-open-session"
            onClick={() => onOpenSession(openRun?.session_id ?? session.id)}
          >
            Open session
          </TaskButton>
          <span className="flex-1" />
          {showStop && (
            <TaskButton tone="ghost" data-testid="tasks-now-stop" onClick={() => onStop(openRun?.id ?? task.run_id)}>
              Stop
            </TaskButton>
          )}
        </TaskCardActions>
      </TaskNowSection>
    </TaskNowShell>
  )
}

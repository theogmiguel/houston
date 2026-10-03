import type { SessionInfo } from '../../houston/client'
import type { TaskAcceptanceItem } from '../../houston/generated/TaskAcceptanceItem'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskRunState } from '../../houston/generated/TaskRunState'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TaskDetailData } from '../../houston/useTasks'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../Icon'
import { IconAgent, IconCheck, IconGitBranch } from '../icons'
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
          <span className={`tk-dot ${runStateTone(state)}`} />
          <span className={`tk-st ${runStateTone(state)}`}>{nowRunLabel(state, status)}</span>
          <span>derived from pane status</span>
        </>
      )}
      {openRun && (
        <span className="inline-flex items-center gap-1.5">
          <IconAgent agent={openRun.provider} brand className="w-3.5 h-3.5 flex-none" />
          {taskAgentLabel(openRun.provider)}
        </span>
      )}
      {openRun?.branch != null && (
        <span className="chip-branch">
          <Icon glyph={IconGitBranch} role="small" />
          <span className="truncate">{openRun.branch}</span>
        </span>
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
      <div className="tk-body muted" style={{ marginTop: 8 }}>
        acceptance {acceptanceText(summary.acceptance_checked, summary.acceptance_total)}
      </div>
    )
  }
  return (
    <div style={{ marginTop: 8 }}>
      {acceptance.map((item) => (
        <div key={item.id} className={`chkl ${item.checked_at_ms != null ? 'on' : ''}`}>
          <span className="bx">{item.checked_at_ms != null && <Icon glyph={IconCheck} role="small" />}</span>
          <span className="tx">{item.text}</span>
        </div>
      ))}
    </div>
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
    <div className="nowcard" data-testid="tasks-now">
      <div className="lab">
        <span>Now · focused pane</span>
        <span className="font-mono tracking-normal">{session.codename}</span>
      </div>
      <div className="t1">{summary?.title ?? task.title}</div>
      <div className="r1">
        <span className="tkchip" data-testid="tasks-now-key">
          <TaskStatusGlyph status={summary?.status ?? task.status} />
          {task.key}
        </span>
        <NowRunMeta state={state} status={summary?.status ?? task.status} openRun={openRun} />
      </div>
      <NowAcceptance acceptance={acceptance} summary={summary} />
      <div className="f">
        <button
          type="button"
          className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28}`}
          data-testid="tasks-now-open-session"
          onClick={() => onOpenSession(openRun?.session_id ?? session.id)}
        >
          Open session
        </button>
        <span className="flex-1" />
        {showStop && (
          <button
            type="button"
            className={`btn ${BTN_GHOST} ${HIT_TARGET_28}`}
            data-testid="tasks-now-stop"
            onClick={() => onStop(openRun?.id ?? task.run_id)}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  )
}

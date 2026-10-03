import type { HoustonClient } from '../../houston/client'
import { useTaskQueue, type TaskQueueResult } from '../../houston/useTasks'
import { openSideTasks } from '../../sidePanel'
import { BTN_PRIMARY } from '../buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Icon } from '../Icon'
import { IconPlay } from '../icons'
import { Tooltip } from '../Tooltip'
import { queuePreview, runNextCount, runNextDisabledReason } from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'
import './tasks.css'

/// The roster's Queue view: the ready pool, the live-children meter against the
/// real cap, and "Run next N" with started keys and refusals inline. Loaded on
/// demand so the backlog helpers stay off the boot path.
export function RosterQueue({
  client,
  workspace,
  parentId,
  live,
  settled,
  cap
}: {
  client: HoustonClient
  workspace: string
  parentId: number
  live: number
  settled: number
  cap: number | null
}): React.JSX.Element {
  const queue = useTaskQueue(client, workspace, true)
  const pool = queuePreview(queue.tasks)
  const ready = queue.readyCount ?? pool.length
  const runCount = runNextCount(ready, live, cap)
  const disabledReason = runNextDisabledReason(ready, live, cap)
  return (
    <div className="queue-panel" data-testid="roster-queue">
      <div className="queue-group"><span>Ready</span><span className="n">{ready}</span></div>
      {pool.length === 0 ? (
        <div className="queue-empty">No ready tasks.</div>
      ) : (
        pool.map((task) => (
          <button
            key={task.id}
            type="button"
            className="queue-row"
            data-testid="queue-row"
            onClick={() => openSideTasks(false, task.id)}
          >
            <span className="l1">
              <TaskStatusGlyph status={task.status} />
              <span className="tk-key">{task.key}</span>
              <span className="flex-1" />
              <TaskPriorityGlyph priority={task.priority} />
            </span>
            <span className="l2"><span className="truncate">{task.title}</span></span>
          </button>
        ))
      )}
      <div className="queue-foot">
        <div className="queue-meter">
          <span>Live children</span>
          <span className="queue-meter-bar">
            <i style={{ flex: live, background: 'var(--info)' }} />
            <i style={{ flex: cap === null ? 1 : Math.max(0, cap - live), background: 'transparent' }} />
          </span>
          <span className="font-mono">{cap === null ? `${live} / ?` : `${live} / ${cap}`}</span>
        </div>
        <div className="queue-note">Settled children ({settled}) do not count against the cap</div>
        <div className="queue-actions">
          <Tooltip label={disabledReason ?? undefined} className="inline-flex">
            <button
              type="button"
              className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28}`}
              data-testid="queue-run-next"
              disabled={runCount === 0}
              onClick={() => queue.run(parentId, runCount)}
            >
              <Icon glyph={IconPlay} role="small" />
              Run next {runCount}
            </button>
          </Tooltip>
        </div>
        {queue.refusal !== null && (
          <div className="queue-result" data-testid="queue-refusal"><div className="bad">{queue.refusal}</div></div>
        )}
        {queue.result !== null && <QueueResult result={queue.result} />}
      </div>
    </div>
  )
}

function QueueResult({ result }: { result: TaskQueueResult }): React.JSX.Element {
  return (
    <div className="queue-result" data-testid="queue-result">
      {result.started.length > 0 && <div className="ok">Started {result.started.join(', ')}</div>}
      {result.refused.map((refusal) => (
        <div key={refusal.key} className="bad">{refusal.key} — {refusal.message}</div>
      ))}
    </div>
  )
}

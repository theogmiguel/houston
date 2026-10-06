import type { HoustonClient } from '../../houston/client'
import { useTaskQueue, type TaskQueueResult } from '../../houston/useTasks'
import { openSideTasks } from '../../sidePanel'
import { Icon } from '../ui/Icon'
import { IconPlay } from '../icons'
import { Tooltip } from '../ui/Tooltip'
import {
  Button,
  RosterQueueEmpty,
  RosterQueueFoot,
  RosterQueueGroup,
  RosterQueueMeter,
  RosterQueueMeterFill,
  RosterQueueNote,
  RosterQueuePanel,
  RosterQueueResult,
  RosterQueueResultLine,
  RosterQueueRow,
  RosterQueueRowSub,
  RosterQueueRowTop,
  TaskKey
} from '../ui'
import { queuePreview, runNextCount, runNextDisabledReason } from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'

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
    <RosterQueuePanel data-testid="roster-queue">
      <RosterQueueGroup label="Ready" count={ready} />
      {pool.length === 0 ? (
        <RosterQueueEmpty>No ready tasks.</RosterQueueEmpty>
      ) : (
        pool.map((task) => (
          <RosterQueueRow key={task.id} data-testid="queue-row" onClick={() => openSideTasks(false, task.id)}>
            <RosterQueueRowTop>
              <TaskStatusGlyph status={task.status} />
              <TaskKey>{task.key}</TaskKey>
              <span className="flex-1" />
              <TaskPriorityGlyph priority={task.priority} />
            </RosterQueueRowTop>
            <RosterQueueRowSub><span className="truncate">{task.title}</span></RosterQueueRowSub>
          </RosterQueueRow>
        ))
      )}
      <RosterQueueFoot>
        <RosterQueueMeter label="Live children" value={cap === null ? `${live} / ?` : `${live} / ${cap}`}>
          <RosterQueueMeterFill weight={live} live />
          <RosterQueueMeterFill weight={cap === null ? 1 : Math.max(0, cap - live)} live={false} />
        </RosterQueueMeter>
        <RosterQueueNote>Settled children ({settled}) do not count against the cap</RosterQueueNote>
        <div className="flex items-center gap-[var(--space-2)]">
          <Tooltip label={disabledReason ?? undefined} className="inline-flex">
            <Button
              type="button"
              variant="legacy-primary"
              data-testid="queue-run-next"
              disabled={runCount === 0}
              onClick={() => queue.run(parentId, runCount)}
            >
              <Icon glyph={IconPlay} role="small" />
              Run next {runCount}
            </Button>
          </Tooltip>
        </div>
        {queue.refusal !== null && (
          <RosterQueueResult data-testid="queue-refusal">
            <RosterQueueResultLine tone="bad">{queue.refusal}</RosterQueueResultLine>
          </RosterQueueResult>
        )}
        {queue.result !== null && <QueueResult result={queue.result} />}
      </RosterQueueFoot>
    </RosterQueuePanel>
  )
}

function QueueResult({ result }: { result: TaskQueueResult }): React.JSX.Element {
  return (
    <RosterQueueResult data-testid="queue-result">
      {result.started.length > 0 && <RosterQueueResultLine tone="ok">Started {result.started.join(', ')}</RosterQueueResultLine>}
      {result.refused.map((refusal) => (
        <RosterQueueResultLine key={refusal.key} tone="bad">{refusal.key} — {refusal.message}</RosterQueueResultLine>
      ))}
    </RosterQueueResult>
  )
}

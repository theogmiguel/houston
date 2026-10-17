import { IconGitPullRequest } from '../icons'
import type { MergeQueueEntry, MergeQueueMerge } from '../../houston/client'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ListDetail, type ListDetailItem } from '../ui/ListDetail'
import { MergeQueueDetail, MergeQueueGates, MergeQueueRowTitle } from '../ui/MergeQueue'
import { Notice } from '../ui/Notice'
import { StatusLabel } from '../ui/StatusLabel'
import { Tooltip } from '../ui/Tooltip'
import { clockTime, entryLine, entryStatus, gateItems, mergedToday, ordinal, shortSha } from './mergeQueueModel'
import type { MergeQueueController } from './useMergeQueue'

interface QueueItem extends ListDetailItem {
  entry?: MergeQueueEntry
  merge?: MergeQueueMerge
}

function queueItems(entries: readonly MergeQueueEntry[], merged: readonly MergeQueueMerge[]): QueueItem[] {
  const inLine = entries.map((entry, index): QueueItem => ({
    id: `entry:${entry.number}`,
    section: 'In line',
    title: <MergeQueueRowTitle rank={entry.position} number={entry.number} heading={entry.title ?? entry.head_ref} />,
    sub: entryLine(entry, entries[index - 1]),
    right: <StatusLabel status={entryStatus(entry)} size="small" />,
    entry
  }))
  const today = merged.map((merge): QueueItem => ({
    id: `merged:${merge.number}:${merge.merged_at_ms}`,
    section: 'Today',
    title: <MergeQueueRowTitle rank={null} number={merge.number} heading={merge.title ?? `#${merge.number}`} />,
    sub: `Merged at ${clockTime(merge.merged_at_ms)} into ${merge.base_ref ?? 'its base'}`,
    right: <StatusLabel status="Merged" size="small" />,
    merge
  }))
  return [...inLine, ...today]
}

function EntryActions({ entry, queue }: { entry: MergeQueueEntry; queue: MergeQueueController }): React.JSX.Element {
  const busy = queue.busy !== null
  const dequeue = <Button variant={entry.position === 1 ? 'ghost' : 'secondary'} size="sm" disabled={busy} onClick={() => queue.dequeue(entry.number)}>Dequeue</Button>
  if (entry.position !== 1) return dequeue
  return <>
    <Tooltip label={entry.reason ?? undefined}><Button variant="primary" size="sm" data-testid="merge-queue-merge" disabled={busy || entry.status !== 'ready'} onClick={() => queue.mergeHead(entry.number, entry.head_sha, 'squash')}>Merge</Button></Tooltip>
    {dequeue}
  </>
}

function QueueDetail({ item, queue }: { item: QueueItem | null; queue: MergeQueueController }): React.JSX.Element | null {
  if (item?.entry) {
    const entry = item.entry
    return <MergeQueueDetail
      heading={`#${entry.number} ${entry.title ?? entry.head_ref}`}
      meta={`${entry.head_ref} · ${shortSha(entry.head_sha)} · ${ordinal(entry.position)} in line`}
      status={entryStatus(entry)}
      gates={<MergeQueueGates gates={gateItems(entry.gates)} />}
      actions={<EntryActions entry={entry} queue={queue} />}
    />
  }
  if (item?.merge) {
    const merge = item.merge
    return <MergeQueueDetail
      heading={`#${merge.number} ${merge.title ?? ''}`}
      meta={`Merged at ${clockTime(merge.merged_at_ms)} with ${merge.method} into ${merge.base_ref ?? 'its base'} at ${shortSha(merge.head_sha)}`}
      status="Merged"
    />
  }
  return null
}

export function MergeQueueView({ queue, now = Date.now() }: { queue: MergeQueueController; now?: number }): React.JSX.Element {
  if (queue.unavailable) return <Notice tone="warn" data-testid="merge-queue-unavailable">{queue.unavailable}</Notice>
  const items = queueItems(queue.entries, mergedToday(queue.merged, now))
  return <div className="grid gap-[var(--space-3)]" data-testid="merge-queue-view">
    {queue.reply && <Notice tone={queue.reply.ok ? 'info' : 'danger'} action={{ label: 'Dismiss', onClick: queue.clearReply }}>{queue.reply.text}</Notice>}
    <ListDetail
      items={items}
      backLabel="Merge queue"
      listEmpty={<EmptyState icon={IconGitPullRequest} heading="The merge queue is empty" description="Pull requests added to the merge queue appear here in the order they merge." />}
      renderDetail={(item) => <QueueDetail item={item} queue={queue} />}
    />
  </div>
}

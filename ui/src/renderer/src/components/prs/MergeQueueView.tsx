import { useEffect, useState } from 'react'
import { IconGitPullRequest } from '../icons'
import type { AgentKind, MergeQueueEntry, MergeQueueLogEntry, MergeQueueSettings } from '../../houston/client'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ListDetail, type ListDetailItem } from '../ui/ListDetail'
import { MergeQueueDetail, MergeQueueFailure, MergeQueueGates, MergeQueuePolicy, MergeQueueRowTitle } from '../ui/MergeQueue'
import { Notice } from '../ui/Notice'
import { StatusLabel } from '../ui/StatusLabel'
import { Tooltip } from '../ui/Tooltip'
import { clockTime, entryLine, entryStatus, gateItems, handOffPrompt, inLine, loggedToday, logLine, logStatus, ordinal, parked, policyLine, shortSha } from './mergeQueueModel'
import { MergeQueueHandOffPicker } from './MergeQueueHandOffPicker'
import type { MergeQueueController } from './useMergeQueue'

interface QueueItem extends ListDetailItem {
  entry?: MergeQueueEntry
  logged?: MergeQueueLogEntry
}

/** A user-initiated pane of `agent` in the entry's worktree, prompted with its failure. */
export type MergeQueueHandOff = (worktree: string, prompt: string, agent: AgentKind) => void

function queueItems(entries: readonly MergeQueueEntry[], log: readonly MergeQueueLogEntry[], settings: MergeQueueSettings | null, now: number): QueueItem[] {
  const line = inLine(entries)
  const row = (section: string) => (entry: MergeQueueEntry, index: number, all: MergeQueueEntry[]): QueueItem => ({
    id: `entry:${entry.number}`,
    section,
    title: <MergeQueueRowTitle rank={entry.position > 0 ? entry.position : null} number={entry.number} heading={entry.title ?? entry.head_ref} />,
    sub: entryLine(entry, all[index - 1], settings, now),
    right: <StatusLabel status={entryStatus(entry)} size="small" />,
    entry
  })
  const today = loggedToday(log, now).map((logged): QueueItem => ({
    id: `log:${logged.kind}:${logged.number}:${logged.at_ms}`,
    section: 'Today',
    title: <MergeQueueRowTitle rank={null} number={logged.number} heading={logged.title ?? `#${logged.number}`} />,
    sub: `${clockTime(logged.at_ms)} · ${logLine(logged)}`,
    right: <StatusLabel status={logStatus(logged)} size="small" />,
    logged
  }))
  return [...line.map(row('In line')), ...parked(entries).map(row('Parked')), ...today]
}

interface ViewActions {
  queue: MergeQueueController
  onHandOff?: MergeQueueHandOff
  /** The workspace's default agent, preselected for a hand-off pane. */
  defaultAgent?: AgentKind | null
}

function EntryActions({ entry, queue, onHandOff, onPick }: { entry: MergeQueueEntry; onPick: () => void } & ViewActions): React.JSX.Element {
  const busy = queue.busy !== null
  const dequeue = <Button variant={entry.position === 1 ? 'ghost' : 'secondary'} size="sm" disabled={busy} data-testid="merge-queue-dequeue" onClick={() => queue.dequeue(entry.number)}>Dequeue</Button>
  if (entry.status === 'parked' || entry.status === 'fixing') {
    return <>
      {onHandOff && entry.worktree && <Button variant="secondary" size="sm" disabled={busy} data-testid="merge-queue-hand-off" onClick={onPick}>Hand to a new pane</Button>}
      <Button variant="primary" size="sm" disabled={busy} data-testid="merge-queue-retry" onClick={() => queue.retry(entry.number)}>Retry</Button>
      {dequeue}
    </>
  }
  if (entry.status === 'watching') return <Tooltip label="Takes it back from GitHub, then out of the queue">{dequeue}</Tooltip>
  if (entry.position !== 1 || queue.settings?.merge_when_verified) return dequeue
  const verified = entry.verification ? `Merges ${shortSha(entry.verification.verified_sha)}, the verified commit, exactly` : undefined
  return <>
    <Tooltip label={entry.reason ?? verified}><Button variant="primary" size="sm" data-testid="merge-queue-merge" disabled={busy || entry.status !== 'ready'} onClick={() => queue.mergeHead(entry.number, entry.head_sha, 'squash')}>Merge</Button></Tooltip>
    {dequeue}
  </>
}

function entryMeta(entry: MergeQueueEntry): string {
  const place = entry.position > 0 ? `${ordinal(entry.position)} in line` : 'out of line'
  return `${entry.head_ref} · ${shortSha(entry.head_sha)} · ${place}`
}

function entryNotice(entry: MergeQueueEntry): React.JSX.Element | undefined {
  const failure = entry.failure
  if (failure) return <MergeQueueFailure reason={failure.handed_to != null ? `${failure.message}. Its pane was told; the queue moved on.` : `${failure.message}. No pane owns it, so it is parked and the queue moved on.`} files={failure.files} output={failure.output_tail} />
  if (entry.github) return <Notice tone="info" data-testid="merge-queue-github">{`GitHub owns ${shortSha(entry.github.head_sha)} now. ${entry.reason ?? 'Houston watches it there'}; Houston finishes the landing once GitHub merges it.`}</Notice>
  return undefined
}

function EntryDetail({ entry, queue, onHandOff, defaultAgent }: { entry: MergeQueueEntry } & ViewActions): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const worktree = entry.worktree
  const actions = picking && onHandOff && worktree
    ? <MergeQueueHandOffPicker defaultAgent={defaultAgent} busy={queue.busy !== null} onCancel={() => setPicking(false)} onOpen={(agent) => { setPicking(false); onHandOff(worktree, handOffPrompt(entry), agent) }} />
    : <EntryActions entry={entry} queue={queue} onHandOff={onHandOff} onPick={() => setPicking(true)} />
  return <MergeQueueDetail
    heading={`#${entry.number} ${entry.title ?? entry.head_ref}`}
    meta={entryMeta(entry)}
    status={entryStatus(entry)}
    notice={entryNotice(entry)}
    gates={<MergeQueueGates gates={gateItems(entry.gates)} />}
    actions={actions}
  />
}

function QueueDetail({ item, queue, onHandOff, defaultAgent }: { item: QueueItem | null } & ViewActions): React.JSX.Element | null {
  if (item?.entry) return <EntryDetail key={item.id} entry={item.entry} queue={queue} onHandOff={onHandOff} defaultAgent={defaultAgent} />
  if (item?.logged) {
    const logged = item.logged
    return <MergeQueueDetail
      heading={`#${logged.number} ${logged.title ?? ''}`}
      meta={`${clockTime(logged.at_ms)} · ${logLine(logged)}${logged.method ? ` with ${logged.method}` : ''}${logged.head_sha ? ` at ${shortSha(logged.head_sha)}` : ''}`}
      status={logStatus(logged)}
      actions={logged.kind === 'merge' ? <Tooltip label="Opens a revert pull request; nothing is pushed to the base"><Button variant="secondary" size="sm" disabled={queue.busy !== null} data-testid="merge-queue-revert" onClick={() => queue.revert(logged.number)}>Revert</Button></Tooltip> : undefined}
    />
  }
  return null
}

/** The time rows count from: `fixed` when given, else a clock that ticks
 *  once a second while an entry verifies and is still otherwise. */
function useClock(running: boolean, fixed: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || fixed !== undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, fixed])
  return fixed ?? now
}

export function MergeQueueView({ queue, now, onHandOff, onOpenSettings, defaultAgent }: { queue: MergeQueueController; now?: number; onHandOff?: MergeQueueHandOff; onOpenSettings?: () => void; defaultAgent?: AgentKind | null }): React.JSX.Element {
  const clock = useClock(queue.entries.some((e) => e.status === 'verifying'), now)
  if (queue.unavailable) return <Notice tone="warn" data-testid="merge-queue-unavailable">{queue.unavailable}</Notice>
  const items = queueItems(queue.entries, queue.log, queue.settings, clock)
  const paused = queue.settings?.paused ?? false
  return <div className="grid gap-[var(--space-3)]" data-testid="merge-queue-view">
    <MergeQueuePolicy actions={<>
      <Button variant="secondary" size="sm" data-testid="merge-queue-pause" disabled={queue.busy !== null || !queue.loaded} onClick={() => queue.setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Button>
      {onOpenSettings && <Button variant="ghost" size="sm" onClick={onOpenSettings}>Settings</Button>}
    </>}>{queue.globalPaused ? 'Every merge queue on this machine is paused' : paused ? 'Paused: nothing is pushed or merged until you resume' : policyLine(queue.settings, queue.handOff)}</MergeQueuePolicy>
    {queue.reply && <Notice tone={queue.reply.ok ? 'info' : 'danger'} action={{ label: 'Dismiss', onClick: queue.clearReply }}>{queue.reply.text}</Notice>}
    <ListDetail
      items={items}
      backLabel="Merge queue"
      listEmpty={<EmptyState icon={IconGitPullRequest} heading="The merge queue is empty" description="Pull requests added to the merge queue appear here in the order they merge." />}
      renderDetail={(item) => <QueueDetail item={item} queue={queue} onHandOff={onHandOff} defaultAgent={defaultAgent} />}
    />
  </div>
}

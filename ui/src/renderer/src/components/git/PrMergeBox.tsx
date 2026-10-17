import type { PrDetail, PrMergeMethod, PullRequestLink } from '../../houston/client'
import type { PrDetailController } from './usePrDetailSubscription'
import { PrChecksList, type PrChecksState } from '../prs/usePrChecksState'
import { checkKey, CheckLog } from '../prs/ChecksList'
import { Button } from '../ui/Button'
import { SplitButton } from '../ui/SplitButton'
import { Tooltip } from '../ui/Tooltip'
import { PrCheckLogFrame, PrMergeFrame, PrMergeFooter, PrReadinessRow } from '../ui/PrPresentation'
import { actionDisabledReason } from './prDetailUi'
import { MergeQueueStanding } from '../ui/MergeQueue'
import { entryStatus, ordinal, queueEntryFor, shortSha } from '../prs/mergeQueueModel'
import type { MergeQueueController } from '../prs/useMergeQueue'

type MergeBoxProps = { link: PullRequestLink; detail: PrDetail; pr: PrDetailController; method: PrMergeMethod; setMethod: (method: PrMergeMethod) => void; mergeReason: string | null; checks: PrChecksState; queue?: MergeQueueController }

function mergeConsequence(link: PullRequestLink, detail: PrDetail, method: PrMergeMethod, waiting: boolean): string {
  if (link.state === 'merged') return 'Merged'
  if (link.state === 'closed') return 'Closed'
  if (detail.auto_merge_enabled) return 'Auto-merge enabled'
  if (detail.mergeable === 'conflicting') return `Conflicts with ${detail.base_ref ?? 'the base branch'}; resolve them before merging`
  if (link.review_decision === 'REVIEW_REQUIRED' || link.review_decision === 'CHANGES_REQUESTED') return 'Review required before merging'
  if (waiting) return `Merges by ${method} once every check passes`
  if (method === 'squash') return `${detail.commit_count} commit${detail.commit_count === 1 ? '' : 's'} become${detail.commit_count === 1 ? 's' : ''} one`
  return method === 'rebase' ? `${detail.commit_count} commits are rebased` : 'Creates a merge commit'
}

function PrFailedChecks({ checks }: { checks: PrChecksState }): React.JSX.Element {
  const props = checks.listProps
  const first = props.checks.find((check) => check.state === 'failing')!
  const key = checkKey(first)
  const open = props.expanded === key
  const duration = first.duration_ms == null ? undefined : `${Math.floor(first.duration_ms / 60000)}m ${Math.floor(first.duration_ms % 60000 / 1000)}s`
  const { checks: _checks, logs, expanded: _expanded, picker, sent, ...logProps } = props
  return <>
    <PrReadinessRow tone="stop" heading={`${first.name} failed`} detail={duration} actions={<div className="flex gap-[var(--space-1)]"><Button variant="ghost" size="sm" aria-expanded={open} onClick={() => props.onToggle(first)}>Log</Button>{!open && <Button variant="secondary" size="sm" onClick={() => { props.onToggle(first); props.onPickAgent(first) }}>Fix with agent</Button>}</div>} />
    {open && <PrCheckLogFrame><CheckLog {...logProps} check={first} log={logs[key]} picker={picker === key} sent={sent[key]} /></PrCheckLogFrame>}
  </>
}

function PrSettledChecks({ checks, waiting }: { checks: PrChecksState; waiting: boolean }): React.JSX.Element {
  const items = checks.listProps.checks
  return <PrReadinessRow tone={waiting ? 'warn' : items.length ? 'ok' : 'muted'} heading={waiting ? 'Checks running' : items.length ? `${checks.passedCount} of ${items.length} checks passed` : 'No checks reported'} />
}

function PrMergeControl({ link, detail, pr, method, setMethod, mergeReason, waiting }: Omit<MergeBoxProps, 'checks'> & { waiting: boolean }): React.JSX.Element | null {
  const busy = pr.write.busy !== null || pr.mergeBusy
  const enabled = detail.auto_merge_enabled === true
  if (link.state !== 'open') return null
  if (link.is_draft) return <Button variant="primary" size="sm" data-testid="pr-action-ready" disabled={busy || actionDisabledReason(detail, 'ready') !== null} onClick={() => pr.action(link.number, 'ready')}>Ready for review</Button>
  if (waiting || enabled) {
    const reason = actionDisabledReason(detail, 'enable_auto_merge')
    return <Tooltip label={reason ?? undefined}><Button variant="secondary" size="sm" data-testid="pr-auto-merge" disabled={busy || enabled || reason !== null} onClick={() => pr.action(link.number, 'enable_auto_merge', { mergeMethod: method })}>Merge when green</Button></Tooltip>
  }
  const labels = { squash: 'Squash and merge', rebase: 'Rebase and merge', merge: 'Merge' }
  const methods = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' }
  return <SplitButton label={labels[method]} testId="pr-merge" disabled={busy || mergeReason !== null} disabledReason={mergeReason ?? undefined} onClick={() => pr.merge(link.number, method, detail.head_sha)} items={(['squash', 'merge', 'rebase'] as const).map((value) => ({ label: `Use ${methods[value]}`, onClick: () => setMethod(value) }))} />
}

/** The merge queue's footer: where this pull request stands in the queue, with
 *  Dequeue or "Add to merge queue". Only the head merges from the queue. */
function PrQueueFooter({ link, detail, method, queue }: { link: PullRequestLink; detail: PrDetail; method: PrMergeMethod; queue: MergeQueueController }): React.JSX.Element | null {
  if (!queue.loaded || queue.unavailable !== null || link.state !== 'open') return null
  const entry = queueEntryFor(queue.entries, link.repository, link.number)
  const busy = queue.busy !== null
  if (!entry) {
    const last = queue.entries.at(-1)
    return <PrMergeFooter consequence={last ? `Not queued; joins after #${last.number}` : 'Not queued'}><Button variant="secondary" size="sm" data-testid="pr-queue-add" disabled={busy} onClick={() => queue.enqueue(link.number)}>Add to merge queue</Button></PrMergeFooter>
  }
  const head = entry.position === 1
  const previous = queue.entries[entry.position - 2]
  const line = entry.reason ?? (head ? `merges ${shortSha(detail.head_sha)} exactly, by ${method}` : `merges after #${previous?.number ?? entry.depends_on}`)
  return <PrMergeFooter consequence={<MergeQueueStanding status={entryStatus(entry)}>{ordinal(entry.position)} in merge queue · {line}</MergeQueueStanding>}>
    <Button variant={head ? 'ghost' : 'secondary'} size="sm" data-testid="pr-queue-dequeue" disabled={busy} onClick={() => queue.dequeue(link.number)}>Dequeue</Button>
    {head && <Tooltip label={entry.reason ?? undefined}><Button variant="primary" size="sm" data-testid="pr-queue-merge" disabled={busy || entry.status !== 'ready'} onClick={() => queue.mergeHead(link.number, detail.head_sha, method)}>Merge</Button></Tooltip>}
  </PrMergeFooter>
}

export function PrMergeBox(props: MergeBoxProps): React.JSX.Element {
  const { link, detail, method, checks, queue } = props
  const queued = queue !== undefined && queueEntryFor(queue.entries, link.repository, link.number) !== null
  const waiting = detail.checks.some((check) => ['failing', 'running', 'queued', 'unknown'].includes(check.state))
  const headline = checks.failedCount > 0 ? checks.listProps.checks.find((check) => check.state === 'failing') : undefined
  const rest = checks.listProps.checks.filter((check) => check !== headline)
  return <PrMergeFrame>
    {checks.failedCount > 0 ? <PrFailedChecks checks={checks} /> : <PrSettledChecks checks={checks} waiting={waiting} />}
    {rest.length > 0 && <PrChecksList state={{ ...checks, listProps: { ...checks.listProps, checks: rest } }} />}
    {queue?.reply && !queue.reply.ok && queue.reply.number === link.number && <PrReadinessRow tone="stop" heading="The merge queue refused" detail={queue.reply.text} />}
    {!queued && <PrMergeFooter consequence={mergeConsequence(link, detail, method, waiting)}><PrMergeControl {...props} waiting={waiting} /></PrMergeFooter>}
    {queue && <PrQueueFooter link={link} detail={detail} method={method} queue={queue} />}
  </PrMergeFrame>
}

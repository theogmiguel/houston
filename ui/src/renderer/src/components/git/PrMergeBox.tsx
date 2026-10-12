import { useState } from 'react'
import type { PrDetail, PrMergeMethod, PullRequestLink } from '../../houston/client'
import type { PrDetailController } from './usePrDetailSubscription'
import type { PrChecksState } from '../prs/usePrChecksState'
import { CheckLog, checkKey } from '../prs/ChecksList'
import { Button } from '../ui/Button'
import { SplitButton } from '../ui/SplitButton'
import { Tooltip } from '../ui/Tooltip'
import { PrMergeFrame, PrMergeFooter, PrReadinessRow } from '../ui/PrPresentation'
import { actionDisabledReason } from './prDetailUi'

export function PrMergeBox({ link, detail, pr, method, setMethod, mergeReason, checks }: { link: PullRequestLink; detail: PrDetail; pr: PrDetailController; method: PrMergeMethod; setMethod: (method: PrMergeMethod) => void; mergeReason: string | null; checks: PrChecksState }): React.JSX.Element {
  const [logOpen, setLogOpen] = useState(false)
  const failed = detail.checks.filter((check) => check.state === 'failing')
  const first = failed[0]
  const pending = detail.checks.filter((check) => ['running', 'queued', 'unknown'].includes(check.state))
  const busy = pr.write.busy !== null || pr.mergeBusy
  const count = detail.commit_count
  const enabled = detail.auto_merge_enabled === true
  const autoReason = actionDisabledReason(detail, 'enable_auto_merge')
  const consequence = enabled ? 'Auto-merge enabled' : failed.length > 0 || pending.length > 0 ? `Merges by ${method} once every check passes` : method === 'squash' ? `${count} commit${count === 1 ? '' : 's'} become${count === 1 ? 's' : ''} one` : method === 'rebase' ? `${count} commits are rebased` : 'Creates a merge commit'
  return <PrMergeFrame>
    {first ? <>
      <PrReadinessRow tone="stop" heading={`${first.name} failed`} detail={first.duration_ms == null ? undefined : `${Math.floor(first.duration_ms / 60000)}m ${Math.floor(first.duration_ms % 60000 / 1000)}s`} actions={<div className="flex gap-[var(--space-1)]"><Button variant="ghost" size="sm" aria-expanded={logOpen} onClick={() => { setLogOpen((open) => !open); if (checks.listProps.expanded !== checkKey(first)) checks.listProps.onToggle(first) }}>Log</Button><Button variant="secondary" size="sm" onClick={() => checks.listProps.onPickAgent(first)}>Fix with agent</Button></div>} />
      {(logOpen || checks.listProps.picker === checkKey(first)) && <CheckLog {...checks.listProps} check={first} log={checks.listProps.logs[checkKey(first)]} picker={checks.listProps.picker === checkKey(first)} sent={checks.listProps.sent[checkKey(first)]} />}
      {failed.slice(1).map((check) => <PrReadinessRow key={checkKey(check)} tone="stop" heading={`${check.name} failed`} />)}
      {checks.passedCount > 0 && <PrReadinessRow tone="ok" heading={`${checks.passedCount} other checks passed`} />}
    </> : <PrReadinessRow tone={pending.length ? 'warn' : detail.checks.length ? 'ok' : 'muted'} heading={pending.length ? 'Checks running' : detail.checks.length ? `${checks.passedCount} of ${detail.checks.length} checks passed` : 'No checks reported'} detail={detail.checks.map((check) => check.name).join(', ')} />}
    <PrReadinessRow tone={link.review_decision === 'REVIEW_REQUIRED' || link.review_decision === 'CHANGES_REQUESTED' ? 'warn' : 'ok'} heading={link.review_decision === 'REVIEW_REQUIRED' || link.review_decision === 'CHANGES_REQUESTED' ? 'Review required' : 'No review required'} />
    <PrReadinessRow tone={detail.mergeable === 'conflicting' ? 'stop' : detail.mergeable === 'mergeable' ? 'ok' : 'muted'} heading={detail.mergeable === 'conflicting' ? `Conflicts with ${detail.base_ref ?? 'base branch unavailable'}` : detail.mergeable === 'mergeable' ? `No conflicts with ${detail.base_ref ?? 'base branch unavailable'}` : 'Conflict status unavailable'} />
    <PrMergeFooter consequence={link.state === 'merged' ? 'Merged' : link.state === 'closed' ? 'Closed' : consequence}>
      {link.state !== 'open' ? null : link.is_draft ? <Button variant="primary" size="sm" data-testid="pr-action-ready" disabled={busy || actionDisabledReason(detail, 'ready') !== null} onClick={() => pr.action(link.number, 'ready')}>Ready for review</Button>
        : failed.length > 0 || pending.length > 0 || enabled ? <Tooltip label={autoReason ?? undefined}><Button variant="secondary" size="sm" data-testid="pr-auto-merge" disabled={busy || enabled || autoReason !== null} onClick={() => pr.action(link.number, 'enable_auto_merge', { mergeMethod: method })}>Merge when green</Button></Tooltip>
          : <SplitButton label={method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : 'Merge'} testId="pr-merge" disabled={busy || mergeReason !== null} disabledReason={mergeReason ?? undefined} onClick={() => pr.merge(link.number, method, detail.head_sha)} items={(['squash', 'merge', 'rebase'] as const).map((value) => ({ label: `Use ${value === 'squash' ? 'Squash' : value === 'merge' ? 'Merge commit' : 'Rebase'}`, onClick: () => setMethod(value) }))} />}
    </PrMergeFooter>
  </PrMergeFrame>
}

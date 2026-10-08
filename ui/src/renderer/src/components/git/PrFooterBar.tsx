import { PrTab } from '../ui/PrTab'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { PullRequestActionsBar } from '../ui/PullRequestActions'
import { ContextMenu, ContextMenuItem, ContextMenuItems, ContextMenuSeparator } from '../ui/ContextMenu'
import { useState } from 'react'
import type {
  PrDetail,
  PrMergeMethod,
  PrUpdateMethod,
  PullRequestLink
} from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconClose, IconCopy, IconExternal, IconGitPullRequest, IconMoreHorizontal } from '../icons'
import { Select, type SelectOption } from '../ui/Select'
import { SplitButton } from '../ui/SplitButton'
import { Tooltip } from '../ui/Tooltip'
import {
  actionDisabledReason,
  stackMergeHeads,
  stackMergeRefusal,
  type PrActionKey
} from './prDetailUi'
import type { PrDetailController } from './usePrDetailSubscription'

const MERGE_METHODS: readonly SelectOption[] = [
  { value: 'squash', label: 'Squash' },
  { value: 'merge', label: 'Merge commit' },
  { value: 'rebase', label: 'Rebase' }
]

const UPDATE_METHODS: readonly SelectOption[] = [
  { value: 'merge', label: 'Merge' },
  { value: 'rebase', label: 'Rebase' }
]

function MergeGlyph(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>
}

/** One pull-request action button, with the reason it cannot be pressed. */
function PrActionButton({
  label,
  testId,
  disabledReason,
  busy,
  onClick,
  danger = false
}: {
  label: string
  testId: string
  disabledReason: string | null
  busy: boolean
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tooltip label={disabledReason ?? undefined} className="inline-flex">
      <ReviewButton variant={danger ? 'pull-request-danger-action' : 'pull-request-action'}
        type="button"
        data-testid={testId}
        disabled={disabledReason !== null || busy}
        onClick={onClick}
      >
        {label}
      </ReviewButton>
    </Tooltip>
  )
}

function PrMergeWhenGreen({
  detail,
  pr,
  method,
  busy,
  number,
  open,
  draft,
  reason
}: {
  detail: PrDetail
  pr: PrDetailController
  method: PrMergeMethod
  busy: boolean
  number: number
  open: boolean
  draft: boolean
  reason: (key: PrActionKey) => string | null
}): React.JSX.Element | null {
  if (!open || draft) return null
  const enabled = detail.auto_merge_enabled === true
  return (
    <PrActionButton
      label="Merge when green"
      testId="pr-auto-merge"
      disabledReason={enabled ? 'Auto-merge is already enabled' : reason('enable_auto_merge')}
      busy={busy}
      onClick={() => pr.action(number, 'enable_auto_merge', { mergeMethod: method })}
    />
  )
}

/** One row of the pull-request actions menu, with the reason it cannot be pressed. */
function PrMenuItem({
  label,
  testId,
  icon,
  disabledReason = null,
  busy = false,
  danger = false,
  onSelect
}: {
  label: string
  testId: string
  icon?: typeof IconCopy
  disabledReason?: string | null
  busy?: boolean
  danger?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <Tooltip label={disabledReason ?? undefined} className="flex w-full">
      <ContextMenuItem
        role="menuitem"
        danger={danger}
        data-testid={testId}
        disabled={disabledReason !== null || busy}
        onClick={onSelect}
      >
        {icon ? <Icon glyph={icon} role="small" /> : <span aria-hidden />}
        <span className="truncate">{label}</span>
      </ContextMenuItem>
    </Tooltip>
  )
}

function PrFooterMenuStackAction({ link, pr, detail, busy, method }: { link: PullRequestLink; pr: PrDetailController; detail: PrDetail; busy: boolean; method: PrMergeMethod }): React.JSX.Element | null {
  const stack = pr.stack
  if (stack === null) return null
  const refusal = stackMergeRefusal(stack, link.number)
  const canMerge = detail.viewer?.can_write === true
  const disabledReason = !canMerge ? 'you do not have write access to this repository' : refusal ?? null
  return <PrMenuItem
    label={`Merge stack to #${link.number}`}
    testId="pr-stack-merge"
    disabledReason={disabledReason}
    busy={busy}
    onSelect={() => pr.mergeStack(link.number, stack.number, stackMergeHeads(stack, link.number), method)}
  />
}

function PrFooterMenuStateActions({ link, detail, pr, open, draft, busy, method, reason, compact, updateMethod, setUpdateMethod }: {
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  open: boolean
  draft: boolean
  busy: boolean
  method: PrMergeMethod
  reason: (key: PrActionKey) => string | null
  compact: boolean
  updateMethod: PrUpdateMethod
  setUpdateMethod: (method: PrUpdateMethod) => void
}): React.JSX.Element {
  const autoMerge = detail.auto_merge_enabled === true
  const autoMergeAction = autoMerge ? 'disable_auto_merge' : 'enable_auto_merge'
  return <>
    {open && !draft && <PrMenuItem label="Convert to draft" testId="pr-action-draft" disabledReason={reason('draft')} busy={busy} onSelect={() => pr.action(link.number, 'draft')} />}
    {open && <PrMenuItem label="Close" testId="pr-action-close" disabledReason={reason('close')} busy={busy} onSelect={() => pr.action(link.number, 'close')} />}
    {open && !draft && <>
      <div className="px-[var(--space-menu-item-x)] py-[var(--space-1)]">
        <Select aria-label="Update method" data-testid="pr-update-method" value={updateMethod} options={UPDATE_METHODS} onChange={(value) => setUpdateMethod(value as PrUpdateMethod)} />
      </div>
      <PrMenuItem label="Update branch" testId="pr-action-update-branch" disabledReason={reason('update_branch')} busy={busy} onSelect={() => pr.action(link.number, 'update_branch', { updateMethod })} />
    </>}
    {open && detail.cross_repository && <PrMenuItem label="Approve workflows" testId="pr-action-approve-workflows" disabledReason={reason('approve_workflows')} busy={busy} onSelect={() => pr.action(link.number, 'approve_workflows')} />}
    {open && !draft && <PrMenuItem label={autoMerge ? 'Disable auto-merge' : compact ? 'Merge when green' : 'Enable auto-merge'} testId="pr-action-auto-merge" disabledReason={reason(autoMergeAction)} busy={busy} onSelect={() => pr.action(link.number, autoMergeAction, { mergeMethod: method })} />}
  </>
}

function PrFooterMenu({
  link,
  detail,
  pr,
  linked,
  open,
  draft,
  busy,
  method,
  reason,
  onOpenUrlInPane,
  compact
}: {
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  linked: boolean
  open: boolean
  draft: boolean
  busy: boolean
  method: PrMergeMethod
  reason: (key: PrActionKey) => string | null
  onOpenUrlInPane?: (url: string) => void
  compact: boolean
}): React.JSX.Element {
  const [updateMethod, setUpdateMethod] = useState<PrUpdateMethod>('merge')
  const hasStateActions = open || pr.stack !== null
  return (
    <ContextMenu
      role="menu"
      data-testid="pr-actions-items"
      className="!absolute bottom-[calc(100%-var(--space-1))] right-[var(--space-2-5)] z-[var(--z-sticky)]"
    >
      <ContextMenuItems>
        {compact && <PrMenuItem label="Open on GitHub" testId="pr-open" icon={IconExternal} disabledReason={onOpenUrlInPane ? null : 'No pane available to open the page'} onSelect={() => onOpenUrlInPane?.(link.url)} />}
        <PrMenuItem label="Copy URL" testId="pr-copy-url" icon={IconCopy} onSelect={() => { void navigator.clipboard?.writeText(link.url) }} />
        {hasStateActions && <>
          <ContextMenuSeparator />
          <PrFooterMenuStackAction link={link} pr={pr} detail={detail} busy={busy} method={method} />
          <PrFooterMenuStateActions link={link} detail={detail} pr={pr} open={open} draft={draft} busy={busy} method={method} reason={reason} compact={compact} updateMethod={updateMethod} setUpdateMethod={setUpdateMethod} />
        </>}
        <ContextMenuSeparator />
        {linked
          ? <PrMenuItem label="Unlink" testId="pr-unlink" icon={IconClose} danger busy={pr.linkBusy} onSelect={pr.unlink} />
          : <PrMenuItem label={`Link #${link.number}`} testId="pr-link-detected" icon={IconGitPullRequest} busy={pr.linkBusy} onSelect={() => pr.link(link.number)} />}
      </ContextMenuItems>
    </ContextMenu>
  )
}

type PrimaryPrAction = { label: string; testId: string; disabledReason: string | null; onClick: () => void } | null

type PrFooterLayoutProps = {
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  linked: boolean
  method: PrMergeMethod
  setMethod: (method: PrMergeMethod) => void
  onOpenUrlInPane?: (url: string) => void
  mergeReason: string | null
  menuOpen: boolean
  setMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  busy: boolean
  reason: (key: PrActionKey) => string | null
  open: boolean
  draft: boolean
  merged: boolean
  closed: boolean
  primary: PrimaryPrAction
}

function PrFooterCompactLayout({ link, detail, pr, linked, method, setMethod, onOpenUrlInPane, mergeReason, menuOpen, setMenuOpen, busy, reason, open, draft, merged, closed, primary }: PrFooterLayoutProps): React.JSX.Element {
  return <PrTab as={PullRequestActionsBar} surface="pr-header-actions" data-testid="pr-actions">
    {primary?.testId === 'pr-merge' ? <SplitButton icon={<MergeGlyph />} label={method === 'squash' ? 'Squash and merge' : method === 'merge' ? 'Merge' : 'Rebase and merge'} testId="pr-merge" disabled={primary.disabledReason !== null || busy || pr.mergeBusy} disabledReason={primary.disabledReason ?? undefined} menuSide="below" glass onClick={primary.onClick} items={MERGE_METHODS.map((option) => ({ label: `Use ${option.label}`, disabled: primary.disabledReason !== null || busy || pr.mergeBusy, disabledReason: primary.disabledReason ?? undefined, onClick: () => setMethod(option.value as PrMergeMethod) }))} />
      : primary ? <Tooltip label={primary.disabledReason ?? undefined} className="inline-flex"><ReviewButton type="button" variant="pull-request-primary-action" data-testid={primary.testId} disabled={primary.disabledReason !== null || busy} onClick={primary.onClick}>{primary.label}</ReviewButton></Tooltip>
        : merged ? <PrTab as="span" surface="pr-merged-state" data-testid="pr-merged-state"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>Merged</PrTab> : closed ? <PrTab as="span" surface="pr-closed-state">Closed</PrTab> : null}
    <Tooltip label="More pull request actions"><ReviewButton variant="pull-request-nav-action" type="button" data-testid="pr-actions-menu" aria-label="More pull request actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon glyph={IconMoreHorizontal} role="small" /></ReviewButton></Tooltip>
    <PrTab as="span" surface="pr-merge-caption" data-testid="pr-merge-caption">{mergeReason ?? 'Ready when checks and required reviews pass'}</PrTab>
    {menuOpen && <PrFooterMenu link={link} detail={detail} pr={pr} linked={linked} open={open} draft={draft} busy={busy} method={method} reason={reason} onOpenUrlInPane={onOpenUrlInPane} compact />}
  </PrTab>
}

function PrFooterWideLayout({ link, detail, pr, linked, method, setMethod, onOpenUrlInPane, mergeReason, menuOpen, setMenuOpen, busy, reason, open, draft, merged, closed, primary }: PrFooterLayoutProps): React.JSX.Element {
  return <PullRequestActionsBar data-testid="pr-actions">
    <ReviewButton variant="pull-request-nav-action" type="button" data-testid="pr-open" disabled={!onOpenUrlInPane} onClick={() => onOpenUrlInPane?.(link.url)}><Icon glyph={IconExternal} role="small" />GitHub</ReviewButton>
    <Tooltip label="More pull request actions"><ReviewButton variant="pull-request-nav-action" type="button" data-testid="pr-actions-menu" aria-label="More pull request actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon glyph={IconMoreHorizontal} role="small" /></ReviewButton></Tooltip>
    <span data-testid="pr-merge-caption">{mergeReason ?? 'Ready when checks and required reviews pass'}</span>
    <span className="flex-1" />
    {primary?.testId === 'pr-merge' ? <SplitButton label={method === 'squash' ? 'Squash and merge' : 'Merge'} testId="pr-merge" disabled={primary.disabledReason !== null || busy || pr.mergeBusy} disabledReason={primary.disabledReason ?? undefined} onClick={primary.onClick} items={MERGE_METHODS.map((option) => ({ label: `Use ${option.label}`, disabled: primary.disabledReason !== null || busy || pr.mergeBusy, disabledReason: primary.disabledReason ?? undefined, onClick: () => setMethod(option.value as PrMergeMethod) }))} />
      : primary ? <Tooltip label={primary.disabledReason ?? undefined} className="inline-flex"><ReviewButton type="button" variant="pull-request-primary-action" data-testid={primary.testId} disabled={primary.disabledReason !== null || busy || pr.mergeBusy} onClick={primary.onClick}>{primary.label}</ReviewButton></Tooltip>
        : closed ? <PrActionButton label="Reopen" testId="pr-action-reopen" disabledReason={reason('reopen')} busy={busy} onClick={() => pr.action(link.number, 'reopen')} />
          : merged ? <PrActionButton label="Revert" testId="pr-action-revert" disabledReason={reason('revert')} busy={busy} danger onClick={() => pr.action(link.number, 'revert')} /> : null}
    <PrMergeWhenGreen detail={detail} pr={pr} method={method} busy={busy} number={link.number} open={open} draft={draft} reason={reason} />
    {menuOpen && <PrFooterMenu link={link} detail={detail} pr={pr} linked={linked} open={open} draft={draft} busy={busy} method={method} reason={reason} onOpenUrlInPane={onOpenUrlInPane} compact={false} />}
  </PullRequestActionsBar>
}

export function PrFooterBar({
  link,
  detail,
  pr,
  linked,
  method,
  setMethod,
  onOpenUrlInPane,
  mergeReason,
  compact = false
}: {
  link: PullRequestLink
  detail: PrDetail
  pr: PrDetailController
  linked: boolean
  method: PrMergeMethod
  setMethod: (method: PrMergeMethod) => void
  onOpenUrlInPane?: (url: string) => void
  mergeReason: string | null
  compact?: boolean
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const busy = pr.write.busy !== null
  const reason = (key: PrActionKey): string | null => actionDisabledReason(detail, key)
  const open = link.state === 'open'
  const draft = link.is_draft && open
  const merged = link.state === 'merged'
  const closed = link.state === 'closed'
  const primary = draft
    ? {
        label: 'Ready for review',
        testId: 'pr-action-ready',
        disabledReason: reason('ready'),
        onClick: () => pr.action(link.number, 'ready')
      }
    : open
      ? {
          label: 'Merge',
          testId: 'pr-merge',
          disabledReason: mergeReason,
          onClick: () => pr.merge(link.number, method, detail.head_sha)
        }
      : null

  const layoutProps: PrFooterLayoutProps = { link, detail, pr, linked, method, setMethod, onOpenUrlInPane, mergeReason, menuOpen, setMenuOpen, busy, reason, open, draft, merged, closed, primary }
  return compact ? <PrFooterCompactLayout {...layoutProps} /> : <PrFooterWideLayout {...layoutProps} />
}

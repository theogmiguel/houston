import { useEffect, useRef, useState } from 'react'
import type { PrDetail, PrMergeMethod, PullRequestLink } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconMoreHorizontal } from '../icons'
import { PrTab } from '../ui/PrTab'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { ContextMenu, ContextMenuItem, ContextMenuItems, ContextMenuSeparator } from '../ui/ContextMenu'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Tooltip } from '../ui/Tooltip'
import { PrMenuCommand } from '../ui/PrPresentation'
import { actionDisabledReason, stackMergeHeads, stackMergeRefusal, type PrActionKey } from './prDetailUi'
import type { PrDetailController } from './usePrDetailSubscription'

type MenuProps = { link: PullRequestLink; detail: PrDetail; pr: PrDetailController; linked: boolean; method: PrMergeMethod; onClose: () => void; onConfirmClose: () => void }

function PrMenuItem({ label, testId, trailing, reason, busy = false, danger = false, onSelect }: { label: string; testId: string; trailing?: React.ReactNode; reason?: string | null; busy?: boolean; danger?: boolean; onSelect: () => void }): React.JSX.Element {
  return <Tooltip label={reason ?? undefined} className="flex w-full"><ContextMenuItem role="menuitem" data-testid={testId} disabled={busy || reason != null} danger={danger} onClick={onSelect}><span>{label}</span>{trailing}</ContextMenuItem></Tooltip>
}

function PrExtraActions({ link, detail, pr, method, onClose }: MenuProps): React.JSX.Element {
  const reason = (action: PrActionKey): string | null => actionDisabledReason(detail, action)
  const busy = pr.write.busy !== null
  const stackReason = pr.stack === null ? null : stackMergeRefusal(pr.stack, link.number)
  return <>
    {detail.cross_repository && link.state === 'open' && <PrMenuItem label="Approve workflows" testId="pr-action-approve-workflows" reason={reason('approve_workflows')} busy={busy} onSelect={() => { pr.action(link.number, 'approve_workflows'); onClose() }} />}
    {detail.auto_merge_enabled && link.state === 'open' && <PrMenuItem label="Disable auto-merge" testId="pr-action-auto-merge" reason={reason('disable_auto_merge')} busy={busy} onSelect={() => { pr.action(link.number, 'disable_auto_merge', { mergeMethod: method }); onClose() }} />}
    {pr.stack !== null && <PrMenuItem label={`Merge stack to #${link.number}`} testId="pr-stack-merge" reason={detail.viewer?.can_write ? stackReason : 'you do not have write access to this repository'} busy={busy} onSelect={() => { if (pr.stack) pr.mergeStack(link.number, pr.stack.number, stackMergeHeads(pr.stack, link.number), method); onClose() }} />}
  </>
}

function PrFooterMenu(props: MenuProps): React.JSX.Element {
  const { link, detail, pr, linked, onClose, onConfirmClose } = props
  const busy = pr.write.busy !== null
  const reason = (action: PrActionKey): string | null => actionDisabledReason(detail, action)
  const act = (action: PrActionKey): void => { pr.action(link.number, action); onClose() }
  const copy = (value: string): void => { void navigator.clipboard?.writeText(value); onClose() }
  return <ContextMenu role="menu" data-testid="pr-actions-items" data-pr-actions-menu>
    <ContextMenuItems>
      <PrMenuItem label="Copy checkout command" testId="pr-copy-checkout" trailing={<PrMenuCommand>gh pr checkout {link.number}</PrMenuCommand>} onSelect={() => copy(`gh pr checkout ${link.number}`)} />
      <PrMenuItem label="Copy link" testId="pr-copy-url" onSelect={() => copy(link.url)} />
      {link.state === 'open' && <>
        <PrMenuItem label={`Update branch from ${detail.base_ref ?? 'base branch unavailable'}`} testId="pr-action-update-branch" reason={reason('update_branch')} busy={busy} onSelect={() => { pr.action(link.number, 'update_branch', { updateMethod: 'merge' }); onClose() }} />
        {!link.is_draft && <PrMenuItem label="Convert to draft" testId="pr-action-draft" reason={reason('draft')} busy={busy} onSelect={() => act('draft')} />}
      </>}
      <PrExtraActions {...props} />
      <ContextMenuSeparator />
      {link.state === 'open' && <PrMenuItem label="Close pull request…" testId="pr-action-close" reason={reason('close')} busy={busy} onSelect={onConfirmClose} />}
      {link.state === 'closed' && <PrMenuItem label="Reopen" testId="pr-action-reopen" reason={reason('reopen')} busy={busy} onSelect={() => act('reopen')} />}
      {link.state === 'merged' && <PrMenuItem label="Revert" testId="pr-action-revert" reason={reason('revert')} busy={busy} onSelect={() => act('revert')} />}
      {linked ? <PrMenuItem label="Unlink from this pane" testId="pr-unlink" danger busy={pr.linkBusy} onSelect={() => { pr.unlink(); onClose() }} /> : <PrMenuItem label={`Link #${link.number}`} testId="pr-link-detected" busy={pr.linkBusy} onSelect={() => { pr.link(link.number); onClose() }} />}
    </ContextMenuItems>
  </ContextMenu>
}

export function PrFooterBar({ link, detail, pr, linked, method }: { link: PullRequestLink; detail: PrDetail; pr: PrDetailController; linked: boolean; method: PrMergeMethod; setMethod: (method: PrMergeMethod) => void; onOpenUrlInPane?: (url: string) => void; mergeReason: string | null; compact?: boolean; menuOnly?: boolean }): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = (): void => setMenuOpen(false)
  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: MouseEvent): void => { if (!host.current?.contains(event.target as Node)) setMenuOpen(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); trigger.current?.focus() } }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [menuOpen])
  return <>
    <PrTab as="div" ref={host} surface="pr-header-actions" data-testid="pr-actions">
      <Tooltip label="More pull request actions"><ReviewButton ref={trigger} variant="pull-request-nav-action" type="button" data-testid="pr-actions-menu" aria-label="More pull request actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon glyph={IconMoreHorizontal} role="small" /></ReviewButton></Tooltip>
      {menuOpen && <PrFooterMenu link={link} detail={detail} pr={pr} linked={linked} method={method} onClose={close} onConfirmClose={() => { close(); setConfirmClose(true) }} />}
    </PrTab>
    {confirmClose && <ConfirmDialog title={`Close pull request #${link.number}?`} confirmLabel="Close pull request" onCancel={() => { setConfirmClose(false); trigger.current?.focus() }} onConfirm={() => { setConfirmClose(false); pr.action(link.number, 'close') }}>
      This closes the pull request without merging its changes. You can reopen it later.
    </ConfirmDialog>}
  </>
}

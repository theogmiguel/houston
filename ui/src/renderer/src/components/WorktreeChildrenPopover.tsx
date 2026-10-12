import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionInfo } from '../houston/client'
import { showItemInFolder } from '../houston/bridge'
import { formatCheckout, sessionCheckoutRoot, tildePath } from './checkout/formatCheckout'
import { useRailGitCache } from './git/railGitCache'
import { IconAgent, IconCopy, IconFolderOpen } from './icons'
import { Button } from './ui/Button'
import { PopoverPanel } from './ui/PopoverPanel'
import {
  WorktreePopoverDivider,
  WorktreePopoverFooter,
  WorktreePopoverGroupLabel,
  WorktreePopoverHeader,
  WorktreePopoverRow
} from './ui/WorktreePopover'
import type { SessionCheckout } from '../houston/generated/SessionCheckout'

type CheckoutOf = SessionInfo & { checkout?: SessionCheckout | null }

const OFFSET_PX = 6
const MARGIN_PX = 8
const PANEL_W = 460
const ROW_SELECTOR = '[data-worktree-row]'

function copy(text: string): void {
  void navigator.clipboard.writeText(text)
}

export function WorktreeChildrenPopover({
  checkout,
  childSessions,
  anchorRef,
  onFocusChild,
  onClose
}: {
  checkout?: SessionCheckout | null
  childSessions: readonly SessionInfo[]
  anchorRef: React.RefObject<HTMLElement | null>
  onFocusChild: (id: number) => void
  onClose: () => void
}): React.JSX.Element {
  const id = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const facts = useRailGitCache()
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)
  const own = formatCheckout(checkout)
  const ownBranch = own.branch ?? checkout?.head ?? own.badge

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const below = a.bottom + OFFSET_PX
    const fitsBelow = below + panel.getBoundingClientRect().height <= window.innerHeight - MARGIN_PX
    const top = fitsBelow ? below : Math.max(MARGIN_PX, a.top - panel.getBoundingClientRect().height - OFFSET_PX)
    const maxLeft = Math.max(MARGIN_PX, window.innerWidth - PANEL_W - MARGIN_PX)
    setPlace({ top, left: Math.max(MARGIN_PX, Math.min(a.left, maxLeft)) })
  }, [anchorRef, childSessions.length])

  useEffect(() => {
    if (place) panelRef.current?.querySelector<HTMLElement>(ROW_SELECTOR)?.focus()
  }, [place != null])

  const close = useCallback(() => {
    onClose()
    anchorRef.current?.focus()
  }, [onClose, anchorRef])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchorRef, onClose])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [])]
    if (rows.length === 0) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % rows.length : (at <= 0 ? rows.length - 1 : at - 1)
    rows[next]?.focus()
  }

  return createPortal(
    <PopoverPanel
      ref={panelRef}
      id={id}
      aria-label="Child worktrees"
      width="list"
      top={place?.top ?? 0}
      left={place?.left ?? 0}
      visible={place != null}
      onKeyDown={onKeyDown}
    >
      <WorktreePopoverHeader
        branch={ownBranch}
        detail={checkout ? `${own.kind === 'worktree' ? 'Worktree' : 'Primary checkout'} · ${tildePath(checkout.root)}` : own.text}
        action={<Button variant="small-icon" icon={IconCopy} aria-label="Copy branch name" onClick={() => copy(ownBranch)} />}
      />
      <WorktreePopoverDivider />
      <WorktreePopoverGroupLabel>Child worktrees · {childSessions.length}</WorktreePopoverGroupLabel>
      {childSessions.map((child) => {
        const childCheckout = (child as CheckoutOf).checkout
        const root = sessionCheckoutRoot(child)
        const stats = facts.get(root)
        const agent = child.agent === 'shell' ? (child.running_agent ?? 'shell') : child.agent
        return (
          <WorktreePopoverRow
            key={child.id}
            rowProps={{ 'data-worktree-row': String(child.id) }}
            agent={<IconAgent agent={agent} role="small" brand />}
            codename={child.codename}
            role={child.delegation?.role ?? child.title}
            branch={formatCheckout(childCheckout).branch ?? '(detached)'}
            ahead={stats?.ahead}
            added={stats?.added}
            deleted={stats?.deleted}
            onSelect={() => { onFocusChild(child.id); onClose() }}
            actions={[
              { label: `Copy path of ${child.codename}`, glyph: IconCopy, onClick: () => copy(root) },
              { label: `Reveal ${child.codename} in file manager`, glyph: IconFolderOpen, onClick: () => { void showItemInFolder(root) } }
            ]}
          />
        )
      })}
      <WorktreePopoverDivider />
      <WorktreePopoverFooter>Select a child to focus its pane</WorktreePopoverFooter>
    </PopoverPanel>,
    document.body
  )
}

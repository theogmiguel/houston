import { useEffect, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { DelegationResult } from '../houston/generated/DelegationResult'
import { isLive } from '../houston/client'
import { ConfirmModal } from './ConfirmModal'
import { Icon } from './ui/Icon'
import { MenuLayer } from './ui/AnimOut'
import { ContextMenu, ContextMenuHeading, ContextMenuItem, ContextMenuItems, ContextMenuSeparator } from './ui/ContextMenu'
import { IconArrowUpRight, IconClose, IconCopy, IconEye, IconStopCircle } from './icons'

export function ChildContextMenu({ child, needsInput, parentId, client, x, y, onClose, onOpen, onMove }: {
  child: SessionInfo
  needsInput: boolean
  parentId: number
  client: HoustonClient
  x: number
  y: number
  onClose: () => void
  onOpen: () => void
  onMove: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [results, setResults] = useState<DelegationResult[]>([])
  const [confirmClose, setConfirmClose] = useState(false)
  const [menuOpen, setMenuOpen] = useState(true)
  const live = isLive(child.state)
  const result = results.find((item) => item.child === child.id)
  const resultText = result?.excerpt || result?.summary
  const left = Math.max(8, Math.min(x, window.innerWidth - 240))
  const top = Math.max(8, Math.min(y, window.innerHeight - 320))

  useEffect(() => {
    const off = client.subscribe('delegation_results', (message) => {
      if (message.parent === parentId) setResults(message.results)
    })
    client.delegationResultsList(parentId)
    return off
  }, [client, parentId])

  const run = (action: () => void): (() => void) => () => {
    onClose()
    action()
  }

  return <>
    <MenuLayer open={menuOpen} onClose={() => { setMenuOpen(false); onClose() }} suppress="popover" menuRef={menuRef}>
      <ContextMenu
        ref={menuRef}
        role="menu"
        aria-label={`${child.title} actions`}
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <ContextMenuHeading title={child.delegation?.role ?? child.title} subtitle={`pane ${child.id}`} />
        <ContextMenuItems>
          {needsInput && <ContextMenuItem role="menuitem" onClick={run(onOpen)}><Icon glyph={IconEye} role="ui" /><span>Answer</span></ContextMenuItem>}
          <ContextMenuItem role="menuitem" onClick={run(onOpen)}><Icon glyph={IconEye} role="ui" /><span>Open</span></ContextMenuItem>
          <ContextMenuItem role="menuitem" onClick={run(onMove)}><Icon glyph={IconArrowUpRight} role="ui" /><span>Move to grid</span></ContextMenuItem>
          <ContextMenuItem role="menuitem" disabled={!resultText} onClick={run(() => {
            if (resultText) void navigator.clipboard.writeText(resultText)
          })}><Icon glyph={IconCopy} role="ui" /><span>Copy result</span></ContextMenuItem>
          <ContextMenuSeparator />
          {live && <ContextMenuItem role="menuitem" onClick={run(() => client.killSession(child.id))}><Icon glyph={IconStopCircle} role="ui" /><span>Stop</span></ContextMenuItem>}
          <ContextMenuItem role="menuitem" danger onClick={live ? () => { setMenuOpen(false); setConfirmClose(true) } : run(() => client.closeSession(child.id))}><Icon glyph={IconClose} role="ui" /><span>Close</span></ContextMenuItem>
        </ContextMenuItems>
      </ContextMenu>
    </MenuLayer>
    {confirmClose && <ConfirmModal title="CLOSE CHILD" message={`Close ${child.delegation?.role ?? child.title}? This stops the running agent and removes its pane.`} confirmLabel="Close child" onConfirm={() => { setConfirmClose(false); client.closeSession(child.id); onClose() }} onCancel={() => { setConfirmClose(false); onClose() }} />}
  </>
}

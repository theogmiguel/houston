import type { PrInfo } from '../../houston/client'
import { showItemInFolder } from '../../houston/bridge'
import { OpenInMenu } from '../OpenInMenu'
import { ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { IconCodeXml, IconFolder, IconGitPullRequest } from '../icons'

// Grid actions the card menu offers beyond its core rows; loaded on demand so the
// editor launcher and bridge helpers stay off the boot path.
export function GridRailExtraActions({
  paneId, checkoutPath, worktreePath, pr, onClose, onOpenInspector, onError,
}: {
  paneId: number | null
  checkoutPath: string
  worktreePath: string | null
  pr: PrInfo | null
  gh: string | null
  onClose: () => void
  onOpenInspector?: (paneId: number, tab: 'pull-request') => void
  onError?: (message: string) => void
}): React.JSX.Element {
  return <>
    {pr && paneId != null && <>
      <ContextMenuItem role="menuitem" onClick={() => { onOpenInspector?.(paneId, 'pull-request'); onClose() }}><Icon glyph={IconGitPullRequest} role="ui" /><span>Open pull request #{pr.number}</span></ContextMenuItem>
    </>}
    <ContextMenuItem role="menuitem" onClick={() => {
      void showItemInFolder(worktreePath ?? checkoutPath).then((result) => { if (!result.ok) onError?.(result.error) })
      onClose()
    }}><Icon glyph={IconFolder} role="ui" /><span>{worktreePath ? 'Reveal worktree in file manager' : 'Reveal in file manager'}</span></ContextMenuItem>
    <OpenInMenu path={worktreePath ?? checkoutPath} icon={<Icon glyph={IconCodeXml} role="ui" />} itemClass="ctx-item" onDone={onClose} onError={(message) => onError?.(message)} />

  </>
}

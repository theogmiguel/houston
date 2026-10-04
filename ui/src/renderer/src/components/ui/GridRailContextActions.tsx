import type { PrInfo } from '../../houston/client'
import { openExternal, showItemInFolder } from '../../houston/bridge'
import { OpenInMenu } from '../OpenInMenu'
import { Icon } from '../Icon'
import { IconCodeXml, IconFolder, IconGitBranch } from '../icons'

export function GridRailContextActions({
  paneId, branch, checkoutPath, worktreePath, pr, gh, onClose, onOpenInspector, onError,
}: {
  paneId: number | null
  branch: string | null
  checkoutPath: string
  worktreePath: string | null
  pr: PrInfo | null
  gh: string | null
  onClose: () => void
  onOpenInspector?: (paneId: number, tab: 'pull-request') => void
  onError?: (message: string) => void
}): React.JSX.Element {
  return <>
    {branch && <button type="button" className="btn ctx-item" role="menuitem" onClick={() => {
      void navigator.clipboard.writeText(branch).then(onClose, (error: unknown) => onError?.(`Copying branch \"${branch}\" failed: ${String(error)}`))
    }}><Icon glyph={IconGitBranch} role="ui" /><span>Copy branch name</span></button>}
    {pr && paneId != null && <>
      <button type="button" className="btn ctx-item" role="menuitem" onClick={() => { onOpenInspector?.(paneId, 'pull-request'); onClose() }}><Icon glyph={IconGitBranch} role="ui" /><span>Open PR #{pr.number}</span></button>
      <button type="button" className="btn ctx-item" role="menuitem" onClick={() => { void openExternal(pr.url); onClose() }}><Icon glyph={IconGitBranch} role="ui" /><span>Open PR on GitHub</span></button>
    </>}
    {gh !== 'ready' && <button type="button" className="btn ctx-item" role="menuitem" disabled><Icon glyph={IconGitBranch} role="ui" /><span>GitHub unavailable</span></button>}
    <button type="button" className="btn ctx-item" role="menuitem" onClick={() => {
      void showItemInFolder(worktreePath ?? checkoutPath).then((result) => { if (!result.ok) onError?.(result.error) })
      onClose()
    }}><Icon glyph={IconFolder} role="ui" /><span>{worktreePath ? 'Reveal worktree in file manager' : 'Reveal in file manager'}</span></button>
    <OpenInMenu path={worktreePath ?? checkoutPath} icon={<Icon glyph={IconCodeXml} role="ui" />} itemClass="ctx-item" onDone={onClose} onError={(message) => onError?.(message)} />
  </>
}

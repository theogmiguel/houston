import { IconGitBranch } from '../icons'
import { ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'

export function GridRailContextActions({
  branch,
  onClose,
  onError,
}: {
  branch: string | null
  onClose: () => void
  onError?: (message: string) => void
}): React.JSX.Element | null {
  if (!branch) return null
  return <ContextMenuItem role="menuitem" onClick={() => {
    void navigator.clipboard.writeText(branch).then(onClose, (error: unknown) => onError?.(`Copying branch "${branch}" failed: ${String(error)}`))
  }}><Icon glyph={IconGitBranch} role="ui" /><span>Copy branch name</span></ContextMenuItem>
}

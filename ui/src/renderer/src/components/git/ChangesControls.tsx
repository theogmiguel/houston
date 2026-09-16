import { IconArrowDown } from '../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'
import { BTN_SECONDARY } from '../buttonChrome'
import { ScmNotice } from './ScmNotice'

// The three controls ChangesPane grew for the Git tools, kept out of the pane's
// render so its complexity stays where the baseline pinned it.

export function ToolsNoticeLine({
  notice,
  error
}: {
  notice: string | null
  error: string | null
}): React.JSX.Element | null {
  if (error !== null) {
    return (
      <ScmNotice tone="danger" testId="changes-tools-error">
        {error}
      </ScmNotice>
    )
  }
  if (notice !== null) {
    return (
      <ScmNotice tone="info" testId="changes-tools-notice">
        {notice}
      </ScmNotice>
    )
  }
  return null
}

export function PullQuickButton({
  upstream,
  behind,
  busy,
  onPull
}: {
  upstream: string | null
  behind: number
  busy: boolean
  onPull: () => void
}): React.JSX.Element | null {
  if (behind === 0 || upstream === null) return null
  return (
    <Tooltip label="Pull the upstream commits into this branch" className="inline-flex">
      <button className={`btn ${BTN_SECONDARY}`} data-testid="changes-pull" disabled={busy} onClick={onPull}>
        <Icon glyph={IconArrowDown} role="small" />
        Pull ↓{behind}
      </button>
    </Tooltip>
  )
}

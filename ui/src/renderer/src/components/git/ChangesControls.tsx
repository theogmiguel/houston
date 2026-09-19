import { SPIN_CLASS } from './DiffBody'
import { IconArrowDown, IconLoaderCircle, IconSparkles } from '../icons'
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

export function GenerateCommitButton({
  staged,
  generating,
  disabled,
  onClick
}: {
  staged: number
  generating: boolean
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        staged === 0
          ? 'Stage something first — the message is written from the staged diff'
          : 'Write a commit message with AI'
      }
      className="inline-flex"
    >
      <button
        className={`btn ${BTN_SECONDARY} flex-none`}
        data-testid="changes-generate-commit"
        aria-label="Write a commit message with AI"
        disabled={disabled || staged === 0 || generating}
        onClick={onClick}
      >
        {generating ? (
          <span className={SPIN_CLASS}>
            <Icon glyph={IconLoaderCircle} role="small" />
          </span>
        ) : (
          <Icon glyph={IconSparkles} role="small" />
        )}
      </button>
    </Tooltip>
  )
}

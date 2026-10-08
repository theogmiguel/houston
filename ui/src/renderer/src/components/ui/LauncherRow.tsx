import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { IconFile, IconGitPullRequest, IconGlobe } from '../icons'
import { Icon } from './Icon'

export interface LauncherRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  label: string
  description: string
  shortcut: string
  disabledReason?: string
}

export function LauncherRow({
  icon,
  label,
  description,
  shortcut,
  disabledReason,
  className = '',
  ...props
}: LauncherRowProps): React.JSX.Element {
  const row = (
    <button
      {...props}
      type="button"
      className={`panel-launcher-row ${disabledReason ? 'is-disabled' : ''} ${className}`}
      aria-disabled={Boolean(disabledReason) || props.disabled || undefined}
    >
      <span className="panel-launcher-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="panel-launcher-copy">
        <span className="panel-launcher-label">{label}</span>
        <span className="panel-launcher-description">{description}</span>
      </span>
      <kbd className="panel-launcher-key">{shortcut}</kbd>
    </button>
  )
  return disabledReason ? <Tooltip label={disabledReason}>{row}</Tooltip> : row
}

export function LauncherRowSpecimen(): React.JSX.Element {
  return (
    <div className="flex w-80 flex-col gap-0.5">
      <LauncherRow
        icon={<Icon glyph={IconGlobe} role="label" />}
        label="Browser"
        description="Browse local pages"
        shortcut="B"
        onClick={() => {}}
      />
      <LauncherRow
        icon={<Icon glyph={IconFile} role="label" />}
        label="Files"
        description="Browse workspace files"
        shortcut="F"
        onClick={() => {}}
      />
      <LauncherRow
        icon={<Icon glyph={IconGitPullRequest} role="label" />}
        label="Pull request"
        description="No branch pull request"
        shortcut="P"
        disabledReason="No pull request for this branch"
      />
    </div>
  )
}

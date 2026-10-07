import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { IconClose } from '../icons'
import { IconCode, IconGitPullRequest } from '../icons'
import { Icon } from './Icon'

export interface PanelTabProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  ariaLabel?: string
  icon: ReactNode
  active: boolean
  onClose?: () => void
}

export function PanelTab({
  label,
  ariaLabel,
  icon,
  active,
  onClose,
  onClick,
  className = '',
  ...props
}: PanelTabProps): React.JSX.Element {
  return (
    <button
      {...props}
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={ariaLabel ?? label}
      className={`panel-tab ${className}`}
      onClick={(event) => {
        if (onClose && (event.target as HTMLElement).closest('.panel-tab-close')) {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        onClick?.(event)
      }}
    >
      <span className="panel-tab-icon" aria-hidden="true">
        <span className="panel-tab-glyph">{icon}</span>
        <span className="panel-tab-close">
          <Icon glyph={IconClose} role="small" />
        </span>
      </span>
      <span className="panel-tab-label">{label}</span>
      {onClose && <span className="sr-only">Close tab</span>}
    </button>
  )
}

export function PanelTabSpecimen(): React.JSX.Element {
  return (
    <div className="side-panel-header">
      <div className="side-panel-tabs" role="tablist" aria-label="Panel surface specimen">
        <PanelTab label="Diff" icon={<Icon glyph={IconCode} role="label" />} active />
        <PanelTab label="Pull request" icon={<Icon glyph={IconGitPullRequest} role="label" />} active={false} />
      </div>
    </div>
  )
}

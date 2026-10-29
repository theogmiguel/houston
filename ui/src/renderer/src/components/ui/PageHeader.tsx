import type { ReactNode } from 'react'
import { Count } from './Count'

export interface PageHeaderProps {
  heading: string
  description?: string
  actions?: ReactNode
  count?: number
}

export function SettingsPageHeader({ heading, description, actions }: PageHeaderProps): React.JSX.Element {
  return <div className="pb-[var(--space-5)]"><PageHeader heading={heading} description={description} actions={actions} /></div>
}

export function PageHeader({ heading, description, actions, count }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="grid gap-[var(--space-3)]">
      {/* The text column holds half the row as its floor: actions wider than that wrap below instead of starving the description. */}
      <div className="flex flex-wrap items-start gap-[var(--space-3)]">
        <div className="grid min-w-[50%] flex-1 gap-[var(--space-1)]">
          <h1 className="m-0 text-[length:var(--tr-text-large-title-size)] font-[var(--tr-text-large-title-weight)] tracking-[var(--tr-text-large-title-tracking)] leading-[var(--tr-text-large-title-leading)] text-[var(--text-primary)]">
            {heading}
            {count !== undefined && <Count value={count} />}
          </h1>
          {description && <p className="m-0 text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)] text-[var(--text-secondary)]">{description}</p>}
        </div>
        {actions && <div className="flex flex-none flex-wrap items-center gap-[var(--space-1-5)]">{actions}</div>}
      </div>
    </header>
  )
}

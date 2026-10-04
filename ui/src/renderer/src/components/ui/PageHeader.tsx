import type { ReactNode } from 'react'
import { Count } from './Count'

export interface PageHeaderProps {
  heading: string
  description?: string
  actions?: ReactNode
  count?: number
}

export function PageHeader({ heading, description, actions, count }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="grid gap-[var(--space-3)]">
      <div className="flex items-start gap-[var(--space-3)]">
        <div className="grid min-w-0 flex-1 gap-[var(--space-1)]">
          <h1 className="m-0 text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.2] text-[var(--text-primary)]">
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

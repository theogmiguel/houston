import type { ReactNode } from 'react'
import { IconTile } from './IconTile'
import { Caption } from './Caption'
import { Card } from './Card'
import { StatusLabel, type StatusLabelValue } from './StatusLabel'

export function IntegrationCard({ icon, title, status, caption, actions }: {
  icon: ReactNode
  title: string
  status: StatusLabelValue
  caption: string
  actions: ReactNode
}): React.JSX.Element {
  return (
    <Card padding="md">
      <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-3)]">
        <IconTile icon={icon} />
        <div className="grid min-w-0 flex-1 gap-[2px]">
          <div className="flex flex-wrap items-center gap-[var(--space-2)] text-[var(--text-primary)]">{title} <StatusLabel status={status} /></div>
          <Caption className="truncate">{caption}</Caption>
        </div>
        {actions}
      </div>
    </Card>
  )
}

import type { HTMLAttributes } from 'react'
import { MATERIAL_CLS } from './material'

export function EndedStatusDot(): React.JSX.Element {
  return <span className="agent-dot w-[7px] h-[7px] rounded-full flex-none bg-[var(--info)]" role="img" aria-label="Ended" />
}

export function RosterColumn({ className = '', ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <aside {...props} className={`children-column ${MATERIAL_CLS.shell} ${className}`} />
}

export function RosterStrip({ className = '', ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <aside {...props} className={`children-strip ${MATERIAL_CLS.shell} ${className}`} />
}

export function RosterQueuePanel({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`queue-panel ${className}`} />
}

export function RosterOverview({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`overview ${className}`} />
}

export function RosterSurfaceSpecimen(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-2)]">
      <RosterColumn aria-label="Children roster specimen">Children roster</RosterColumn>
      <RosterStrip aria-label="Children strip specimen">Children strip</RosterStrip>
      <EndedStatusDot />
      <RosterQueuePanel>Ready tasks</RosterQueuePanel>
      <RosterOverview>Orchestrator overview</RosterOverview>
    </div>
  )
}

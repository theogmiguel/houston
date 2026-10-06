import type { ReactNode } from 'react'
import { Count } from './Count'

export interface SectionHeadProps {
  title: string
  count?: number
  action?: ReactNode
  inset?: boolean
}

export function SectionHead({ title, count, action, inset = false }: SectionHeadProps): React.JSX.Element {
  return (
    <h2 className={`m-0 flex min-w-0 items-center gap-[var(--space-2)] ${inset ? 'pl-[var(--space-2-5)]' : ''}`}>
      <span className="flex min-w-0 items-center text-[length:var(--tr-text-label-size)] font-[var(--tr-text-label-weight)] tracking-[var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)]">
        {title}
        {count !== undefined && <Count value={count} />}
      </span>
      {action && <span className="ml-auto flex flex-none items-center">{action}</span>}
    </h2>
  )
}

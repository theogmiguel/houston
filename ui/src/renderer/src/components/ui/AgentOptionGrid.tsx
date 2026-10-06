import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './Button'
import { Text } from './Text'

export function AgentOptionGrid({ children, label, className = '', ...props }: HTMLAttributes<HTMLFieldSetElement> & { children: ReactNode; label: string }): React.JSX.Element {
  return (
    <fieldset {...props} className={`m-0 flex flex-col gap-[var(--space-2)] border-0 p-0 ${className}`}>
      <Text as="legend" size="label" weight="label" tone="faint" className="block [line-height:var(--tr-picker-label-leading)]">{label}</Text>
      <div className="grid grid-cols-2 gap-[var(--space-2)]">{children}</div>
    </fieldset>
  )
}

export function SelectionMark({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full bg-[var(--accent)] text-white">{children}</span>
}

export function AgentOptionGridSpecimen(): React.JSX.Element {
  return <AgentOptionGrid label="Engine"><Button variant="agent-option" selected>Selected provider</Button><Button variant="agent-option">Available provider</Button></AgentOptionGrid>
}

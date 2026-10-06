import type { HTMLAttributes, ReactNode } from 'react'
import { Caption } from './Caption'

export interface ContentSectionProps extends HTMLAttributes<HTMLElement> {
  heading: string
  description: string
  children: ReactNode
}

export function ContentSection({ heading, description, children, ...props }: ContentSectionProps): React.JSX.Element {
  return (
    <section {...props} className="grid gap-[var(--space-2)] pt-[var(--space-6)]">
      <h2 className="m-0 text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{heading}</h2>
      <Caption>{description}</Caption>
      {children}
    </section>
  )
}

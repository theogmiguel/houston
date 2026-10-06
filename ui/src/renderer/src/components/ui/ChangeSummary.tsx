import type { HTMLAttributes, ReactNode } from 'react'

export function ChangeSummary({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="border-t border-t-[var(--divider)] py-[var(--space-3)] px-[var(--space-4)] [font-size:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)] whitespace-pre-wrap break-words">{children}</div>
}

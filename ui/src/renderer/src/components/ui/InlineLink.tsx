import type { ReactNode } from 'react'

export function InlineLink({ href, children }: { href: string; children: ReactNode }): React.JSX.Element {
  return <a href={href} target="_blank" rel="noreferrer" className="break-all text-[var(--accent)] underline [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">{children}</a>
}

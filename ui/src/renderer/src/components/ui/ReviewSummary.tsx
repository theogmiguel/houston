import type { ReactNode } from 'react'
import { Card } from './Card'
import { Text } from './Text'
export function ReviewSummary({ heading, detail, chart, action }: { heading: string; detail: ReactNode; chart?: ReactNode; action: ReactNode }): React.JSX.Element {
  return <Card shape="card" data-testid="review-summary"><div className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)]"><span className="grid min-w-[min(100%,var(--w-review-summary-copy))] flex-1 gap-[var(--space-1)]"><Text as="h2" size="subhead" weight="subhead" tone="primary" flush>{heading}</Text><Text size="small" leading="small" tone="muted">{detail}</Text></span><span className="flex flex-none items-center gap-[var(--space-4)]">{chart}{action}</span></div></Card>
}

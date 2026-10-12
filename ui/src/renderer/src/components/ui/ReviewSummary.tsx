import type { ReactNode } from 'react'
import { Card } from './Card'
import { Text } from './Text'
export function ReviewSummary({ heading, detail, chart, action }: { heading: string; detail: ReactNode; chart?: ReactNode; action: ReactNode }): React.JSX.Element {
  return <Card shape="card" data-testid="review-summary"><div className="flex flex-wrap items-center gap-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)]"><span className="grid min-w-0 flex-1 gap-[var(--space-1)]"><Text size="ui" weight="medium">{heading}</Text><Text size="small" tone="muted">{detail}</Text></span>{chart}{action}</div></Card>
}

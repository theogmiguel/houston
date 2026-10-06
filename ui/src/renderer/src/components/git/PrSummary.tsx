import { PullRequestRole } from '../ui/PullRequestRoles'

export function PrSummary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <PullRequestRole as="div" role="summary-content" className="flex-1" data-testid="pr-summary">
      {children}
    </PullRequestRole>
  )
}

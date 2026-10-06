import { EmptyState } from '../ui/EmptyState'

export function PrEmptyStates({
  testId,
  headline,
  description
}: {
  testId: string
  headline: string
  description: string
}): React.JSX.Element {
  return <EmptyState data-testid={testId} heading={headline} description={description} fill copy="compact" descriptionWidth="compact" />
}

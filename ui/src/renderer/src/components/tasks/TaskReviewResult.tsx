import type { TaskReviewVerdict as TaskReviewVerdictData } from '../../houston/generated/TaskReviewVerdict'
import { TaskStructuredReview } from '../ui/TaskRunSurface'

export { shortHeadSha } from '../ui/TaskRunSurface'

/** The run card's structured review, composed from the run surface primitives. */
export function TaskReviewResult({ review }: { review: TaskReviewVerdictData }): React.JSX.Element {
  return <TaskStructuredReview review={review} />
}

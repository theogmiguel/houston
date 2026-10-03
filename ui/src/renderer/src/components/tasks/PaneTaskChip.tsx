import { lazy, Suspense } from 'react'
import type { SessionTask } from '../../houston/generated/SessionTask'

// The chip carries the Tasks formatting helpers; load it on demand so they
// stay off the boot path.
const TaskChip = lazy(() => import('./TaskChip').then((module) => ({ default: module.TaskChip })))

// Pane-header slot for the bound task: nothing while the pane has none.
export function PaneTaskChip({ task }: { task: SessionTask | null | undefined }): React.JSX.Element | null {
  if (task == null) return null
  return (
    <Suspense fallback={null}>
      <TaskChip task={task} />
    </Suspense>
  )
}

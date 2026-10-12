import type { ReactNode } from 'react'
import type { Routine, RoutineWorkspaceOption } from '../../houston/routineTypes'
import { Card, Chip, EmptyState, SectionHead, Select } from '../ui'
import { IconClock } from '../icons'
import { ReviewDescription } from './WeeklyReviewDetail'

export function WeeklyReviewWorkspaces({ reviews, workspaces, connected, onSetup, renderReview }: {
  reviews: Routine[]
  workspaces: RoutineWorkspaceOption[]
  connected: boolean
  onSetup: (workspace: RoutineWorkspaceOption) => void
  renderReview: (routine: Routine, workspaceName: string) => ReactNode
}): React.JSX.Element {
  const available = workspaces.filter((workspace) => !reviews.some((routine) => routine.workspace_id === workspace.id))
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  return <div className="grid min-w-0 gap-[var(--space-3)]">
    <SectionHead title="Weekly review" variant="title" badge={<Chip variant="label" label="Built in" />} />
    <ReviewDescription />
    {connected && available.length > 0 && <Select aria-label="Set up for a workspace" data-testid="review-setup-workspace"
      value="" prefix="Set up for a workspace" options={available.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
      onChange={(id) => { const workspace = available.find((item) => item.id === id); if (workspace) onSetup(workspace) }} width="full" />}
    {reviews.length === 0 && <EmptyState icon={IconClock} heading="No workspaces set up" description="Set up Weekly review for a workspace to choose its provider and schedule." />}
    {reviews.map((routine) => {
      const name = workspaceById.get(routine.workspace_id ?? '') ?? routine.workspace_id ?? 'Unavailable workspace'
      return <Card key={routine.id} padding="md" role="region" aria-label={`Review for ${name}`}>
        {renderReview(routine, name)}
      </Card>
    })}
  </div>
}

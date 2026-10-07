import { lazy, Suspense } from 'react'
import type { MutableRefObject } from 'react'
import type { RailCard } from '../../rail/railCardModel'

const GridRailHoverCard = lazy(() => import('../GridRailHoverCard').then((module) => ({ default: module.GridRailHoverCard })))

export function GridRailHoverCardHost({
  card,
  position,
  closeTimer,
  scheduleClose,
  onOpenInspector,
}: {
  card: RailCard
  position: { left: number; top: number }
  closeTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>
  scheduleClose: () => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <GridRailHoverCard
        card={card}
        position={position}
        closeTimer={closeTimer}
        scheduleClose={scheduleClose}
        onOpenInspector={onOpenInspector}
      />
    </Suspense>
  )
}

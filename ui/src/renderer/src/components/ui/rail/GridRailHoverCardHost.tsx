import type { MutableRefObject } from 'react'
import type { RailCard } from '../../rail/railCardModel'
import type { TagInfo } from '../../../houston/generated/TagInfo'
import { GridRailHoverCard } from '../GridRailHoverCard'

export function GridRailHoverCardHost({
  card,
  tags,
  position,
  visible,
  closeTimer,
  scheduleClose,
  onOpenInspector,
}: {
  card: RailCard
  tags?: readonly TagInfo[]
  position: { left: number; top: number }
  visible: boolean
  closeTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>
  scheduleClose: () => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element {
  return <GridRailHoverCard
        card={card}
        tags={tags}
        position={position}
        visible={visible}
        closeTimer={closeTimer}
        scheduleClose={scheduleClose}
        onOpenInspector={onOpenInspector}
      />
}

import { useNativeOverlaySuppression } from '../../layout/nativeSuppression'
import { useMascotSlot } from '../../mascot/mascotSlots'
import type { Mood } from '../../mascot/mascotDirector'
import { MascotArt } from './MascotArt'
export default function MascotSurface({ mood, hat, placement = 'inline' }: { mood: Mood; hat?: 'party' | 'bandage'; placement?: 'inline' | 'reconnect' }): React.JSX.Element {
  const ref = useMascotSlot(1)
  useNativeOverlaySuppression('popover', placement === 'reconnect', ref)
  return <div ref={ref} className={placement === 'reconnect' ? 'mascot-reconnect' : 'mascot-surface'}><MascotArt size={112} mood={mood} outfit={{ head: hat, body: mood === 'read' ? 'book' : undefined }} /></div>
}

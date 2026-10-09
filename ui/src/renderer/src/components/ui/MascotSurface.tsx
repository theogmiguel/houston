import { useRef } from 'react'
import { useNativeOverlaySuppression } from '../../layout/nativeSuppression'
import type { Mood } from '../../mascot/mascotDirector'
import { MascotRig } from './MascotRig'
export default function MascotSurface({ mood, hat, placement = 'inline' }: { mood: Mood; hat?: 'party' | 'bandage'; placement?: 'inline' | 'reconnect' }): React.JSX.Element {
  const ref=useRef<HTMLDivElement>(null)
  useNativeOverlaySuppression('popover',placement==='reconnect',ref)
  const rig=<MascotRig size={112} mood={mood} outfit={{ head: hat, body: mood === 'read' ? 'book' : undefined }} />
  return placement==='reconnect' ? <div ref={ref} className="mascot-reconnect">{rig}</div> : rig
}

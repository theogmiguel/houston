import type { CSSProperties } from 'react'
import { useMascotPrefs, type MascotPrefs } from '../../mascot/mascotPrefs'
import { MASCOT_FILTERS } from '../../mascot/mascotColors'
import type { Mood, Outfit } from '../../mascot/mascotDirector'
import { MascotRig, MascotPixel } from './MascotRig'
import { useMascotMotion } from './useMascotMotion'

export function MascotArt({ size = 64, mood = 'idle', outfit = {}, prefs: override }: { size?: number; mood?: Mood; outfit?: Outfit; prefs?: MascotPrefs }): React.JSX.Element {
  const stored = useMascotPrefs()
  const prefs = override ?? stored
  const { reduced, paused } = useMascotMotion(prefs.background)
  return <div data-mascot-visual className="mascot-art mascot-motion loop-anim" data-reduced={reduced} data-paused={paused} data-background={prefs.background} style={{ '--size': `${size}px`, filter: MASCOT_FILTERS[prefs.colors] } as CSSProperties}>
    {prefs.style === 'pixel' ? <MascotPixel size={size} mood={mood} outfit={outfit} reduced={reduced} paused={paused} /> : <MascotRig size={size} mood={mood} outfit={outfit} background={prefs.background} />}
  </div>
}

export function MascotArtSpecimen(): React.JSX.Element {
  return <div className="flex gap-[var(--space-5)]"><MascotArt size={112} /><MascotArt size={112} prefs={{ ...useMascotPrefs(), style: 'pixel' }} /></div>
}

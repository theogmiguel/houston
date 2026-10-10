import type { ReactNode } from 'react'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { MascotParticles } from './MascotRig'
import { MascotArt } from './MascotArt'
import { useMascotSlot } from '../../mascot/mascotSlots'
import type { Mood, Outfit } from '../../mascot/mascotDirector'
import type { MascotPrefs } from '../../mascot/mascotPrefs'
export const NavigationRailCompanion = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  mood: Mood; outfit: Outfit; prefs: MascotPrefs; line?: string; effect?: string; bump?: string; paused: boolean; reduced: boolean
}>(function NavigationRailCompanion({ mood, outfit, prefs, line, effect, bump, paused, reduced, ...props }, ref) {
  const slot = useMascotSlot(0)
  return <div ref={slot} className="mascot-slot"><button {...props} ref={ref} type="button" data-testid="mascot-companion" aria-label="Houston mascot" className={`mascot-buddy mascot-motion loop-anim ${line ? 'talk' : ''} ${bump ?? ''}`} data-skin={prefs.style} data-outfit={prefs.colors} data-reduced={reduced} data-paused={paused} data-background={prefs.background}>
    <span className="sprite"><MascotArt prefs={prefs} mood={mood} outfit={outfit} /></span>
    <span className="bubble" aria-live="polite">{line}</span>
    {!reduced && <><MascotParticles kind={outfit.fx} /><MascotParticles key={effect} kind={effect?.split(':')[0]} once /></>}
  </button></div>
})

export function MascotDiscoScope({ active, children }: { active: boolean; children: ReactNode }): React.JSX.Element { return <div className={active ? "mascot-disco" : undefined}>{children}</div> }

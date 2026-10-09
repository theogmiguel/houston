import type { ReactNode } from 'react'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { MascotRig, MascotPixel, MascotParticles } from './MascotRig'
import type { Mood, Outfit } from '../../mascot/mascotDirector'
import type { MascotPrefs } from '../../mascot/mascotPrefs'
export const NavigationRailCompanion = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  mood: Mood; outfit: Outfit; prefs: MascotPrefs; line?: string; effect?: string; bump?: string; paused: boolean; reduced: boolean
}>(function NavigationRailCompanion({ mood, outfit, prefs, line, effect, bump, paused, reduced, ...props }, ref) {
  return <div className="mascot-slot"><button {...props} ref={ref} type="button" data-testid="mascot-companion" aria-label="Houston mascot" className={`mascot-buddy mascot-motion loop-anim ${line ? 'talk' : ''} ${bump ?? ''}`} data-skin={prefs.style} data-outfit={prefs.colors} data-reduced={reduced} data-paused={paused} data-background={prefs.background}>
    <span className="sprite">{prefs.style === 'rig' ? <MascotRig mood={mood} outfit={outfit} background={prefs.background} /> : <MascotPixel mood={mood} outfit={outfit} reduced={reduced} paused={paused} />}</span>
    <span className="bubble" aria-live="polite">{line}</span>
    {!reduced && <><MascotParticles kind={outfit.fx} /><MascotParticles key={effect} kind={effect?.split(':')[0]} once /></>}
  </button></div>
})

export function MascotDiscoScope({ active, children }: { active: boolean; children: ReactNode }): React.JSX.Element { return <div className={active ? "mascot-disco" : undefined}>{children}</div> }

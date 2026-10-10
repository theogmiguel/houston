import { lazy, Suspense, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import { MascotDockSlot } from '../components/ui/MascotDockSlot'
import { MascotRailContext } from './mascotRailContext'
import { useMascotPlacement } from './mascotPosition'
import { useMascotPrefs } from './mascotPrefs'
import type { Mood } from './mascotDirector'
const Companion = lazy(() => import('./MascotCompanion'))
const Surface = lazy(() => import('../components/ui/MascotSurface'))
export function MascotMount({ existingUser, firstRun = false, workspacesEmpty = false }: { existingUser: boolean; firstRun?: boolean; workspacesEmpty?: boolean }): React.JSX.Element | null {
  const prefs = useMascotPrefs()
  const register = useContext(MascotRailContext)
  const ref = useRef<HTMLDivElement>(null)
  const { dragging } = useMascotPlacement()
  useLayoutEffect(() => {
    if (prefs.enabled && register && ref.current) return register({ node: ref.current, existingUser, firstRun: firstRun || workspacesEmpty })
  }, [prefs.enabled, register, existingUser, firstRun, workspacesEmpty])
  if (register) return prefs.enabled ? <MascotDockSlot ref={ref} dragging={dragging} /> : null
  return prefs.enabled ? <Suspense fallback={null}><Companion existingUser={existingUser} firstRun={firstRun || workspacesEmpty} /></Suspense> : null
}
export function MascotSurfaceMount({ mood = 'idle', hat, fallback = null, placement = 'inline' }: { mood?: Mood; hat?: 'party' | 'bandage'; fallback?: ReactNode; placement?: 'inline' | 'reconnect' }): React.JSX.Element | null {
  const prefs = useMascotPrefs()
  return prefs.enabled ? <Suspense fallback={null}><Surface mood={mood} hat={hat} placement={placement} /></Suspense> : <>{fallback}</>
}

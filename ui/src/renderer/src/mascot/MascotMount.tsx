import { lazy, Suspense, type ReactNode } from 'react'
import { useMascotPrefs } from './mascotPrefs'
import type { Mood } from './mascotDirector'
const Companion = lazy(() => import('./MascotCompanion'))
const Surface = lazy(() => import('../components/ui/MascotSurface'))
export function MascotMount({ existingUser, firstRun = false, workspacesEmpty = false }: { existingUser: boolean; firstRun?: boolean; workspacesEmpty?: boolean }): React.JSX.Element | null {
  const prefs = useMascotPrefs()
  return prefs.enabled ? <Suspense fallback={null}><Companion existingUser={existingUser} firstRun={firstRun || workspacesEmpty} /></Suspense> : null
}
export function MascotSurfaceMount({ mood = 'idle', hat, fallback = null, placement = 'inline' }: { mood?: Mood; hat?: 'party' | 'bandage'; fallback?: ReactNode; placement?: 'inline' | 'reconnect' }): React.JSX.Element | null {
  const prefs = useMascotPrefs()
  return prefs.enabled ? <Suspense fallback={null}><Surface mood={mood} hat={hat} placement={placement} /></Suspense> : <>{fallback}</>
}

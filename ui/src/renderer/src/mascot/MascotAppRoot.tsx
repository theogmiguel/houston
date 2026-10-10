import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react'
import { useMascotPrefs } from './mascotPrefs'
import { MascotRailContext, type MascotRail } from './mascotRailContext'
const Host = lazy(() => import('./MascotFloatingHost'))

export function MascotAppRoot({ children }: { children: ReactNode }): React.JSX.Element {
  const prefs = useMascotPrefs()
  const [rail, setRail] = useState<MascotRail | null>(null)
  const register = useCallback((next: MascotRail): (() => void) => {
    setRail(next)
    return () => setRail(current => current?.node === next.node ? null : current)
  }, [])
  return <MascotRailContext.Provider value={register}>{children}{prefs.enabled && <Suspense fallback={null}><Host rail={rail} /></Suspense>}</MascotRailContext.Provider>
}

import { useLayoutEffect, useSyncExternalStore } from 'react'
interface MascotLifecycle { existingUser: boolean; firstRun: boolean }
let lifecycle: MascotLifecycle | null = null
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
function publish(next: MascotLifecycle | null): void { lifecycle = next; listeners.forEach(fn => fn()) }
export function useReportMascotLifecycle(workspaceCount: number, firstRun: boolean, workspacesEmpty: boolean): void {
  useLayoutEffect(() => {
    publish({ existingUser: workspaceCount > 0, firstRun: firstRun || workspacesEmpty })
  }, [workspaceCount, firstRun, workspacesEmpty])
  useLayoutEffect(() => () => publish(null), [])
}
export const useMascotLifecycle = (): MascotLifecycle | null => useSyncExternalStore(subscribe, () => lifecycle, () => null)

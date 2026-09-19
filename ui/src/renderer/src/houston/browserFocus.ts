import { useEffect, useRef } from 'react'
import { isTauri } from './host'

const FOCUS_EVENT = 'browser://focus'

export function useBrowserFocus(onFocus: (id: string) => void): void {
  const cb = useRef(onFocus)
  cb.current = onFocus

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const dispose = await listen<{ id: string }>(FOCUS_EVENT, (event) => {
        cb.current(event.payload.id)
      })
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}

import { useEffect, useRef } from 'react'
import { isTauri } from './host'

const OPEN_REQUEST_EVENT = 'browser://open-request'

export function useBrowserOpenRequest(onRequest: (workspaceId: string) => void): void {
  const cb = useRef(onRequest)
  cb.current = onRequest

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const dispose = await listen<{ workspaceId: string }>(OPEN_REQUEST_EVENT, (event) => {
        cb.current(event.payload.workspaceId)
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

import { useEffect, useRef } from 'react'
import { isTauri } from './host'

const OPEN_REQUEST_EVENT = 'browser://open-request'

export function useBrowserOpenRequest(onRequest: (workspaceId: string, url: string, surfaceId?: string) => void): void {
  const cb = useRef(onRequest)
  cb.current = onRequest

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const dispose = await listen<{ workspaceId: string; url: string; surfaceId?: string }>(OPEN_REQUEST_EVENT, (event) => {
        cb.current(event.payload.workspaceId, event.payload.url, event.payload.surfaceId)
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

// An open request can find a browser pane that exists but has no page, and therefore no
// surface the host can navigate; the pane itself has to load the URL.
const loaders = new Map<string, (url: string) => void>()

export function requestBrowserPaneLoad(paneId: string, url: string): boolean {
  const load = loaders.get(paneId)
  if (!load) return false
  load(url)
  return true
}

export function useBrowserPaneLoad(paneId: string, onLoad: (url: string) => void): void {
  const cb = useRef(onLoad)
  cb.current = onLoad

  useEffect(() => {
    const load = (url: string): void => cb.current(url)
    loaders.set(paneId, load)
    return () => {
      if (loaders.get(paneId) === load) loaders.delete(paneId)
    }
  }, [paneId])
}

export function reuseSideBrowser(workspace: string, url: string, surfaceId?: string): boolean {
  void workspace
  void url
  void surfaceId
  return false
}

export function routeBrowserOpenRequest(workspace: string, url: string, surfaceId: string | undefined, revealGrid: (workspace: string, surfaceId: string) => boolean, open: (workspace: string, url: string) => void): void {
  if (surfaceId !== undefined && revealGrid(workspace, surfaceId)) return
  if (reuseSideBrowser(workspace, url, surfaceId)) return
  if (surfaceId !== undefined) return
  open(workspace, url)
}

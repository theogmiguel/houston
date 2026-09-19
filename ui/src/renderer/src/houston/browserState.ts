import { useEffect, useRef, useState } from 'react'
import { isTauri } from './host'

export interface BrowserStateError {
  kind: string
  message: string
  failingUrl: string | null
}

export interface BrowserState {
  id: string
  url: string | null
  title: string | null
  favicon: string | null
  loading: boolean
  progress: number
  canGoBack: boolean
  canGoForward: boolean
  error: BrowserStateError | null
  mountFailed: boolean
}

const STATE_EVENT = 'browser://state'
const OPEN_URL_EVENT = 'browser://open-url'

export interface BrowserOpenUrl {
  id: string
  url: string
}

let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null
function eventApiModule(): Promise<typeof import('@tauri-apps/api/event')> {
  eventApi ??= import('@tauri-apps/api/event').catch((err: unknown) => {
    eventApi = null
    throw err
  })
  return eventApi
}

export function useBrowserState(id: string): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(null)

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await eventApiModule()
      const dispose = await listen<BrowserState>(STATE_EVENT, (event) => {
        if (event.payload.id !== id) return
        setState(event.payload)
      })
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })().catch((err: unknown) => {
      console.error(`[browser] ${STATE_EVENT} subscribe failed for ${JSON.stringify(id)}:`, err)
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [id])

  return state
}

export function useBrowserOpenUrl(id: string, onOpen: (url: string) => void): void {
  const handler = useRef(onOpen)
  handler.current = onOpen

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await eventApiModule()
      const dispose = await listen<BrowserOpenUrl>(OPEN_URL_EVENT, (event) => {
        if (event.payload.id !== id) return
        handler.current(event.payload.url)
      })
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })().catch((err: unknown) => {
      console.error(`[browser] ${OPEN_URL_EVENT} subscribe failed for ${JSON.stringify(id)}:`, err)
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [id])
}

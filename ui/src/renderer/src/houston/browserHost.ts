import { useCallback, useEffect, useRef, useState } from 'react'
import { notifyBrowserSurfaceRects } from './browserSurfaceRegistry'
import { isTauri } from './host'
import {
  BrowserGeometryEngine,
  type BrowserCommands,
  type CornerSpec,
  type Measure,
  type Rect
} from './browserGeometry'

const DETACHED_CLOSED_EVENT = 'browser://detached-closed'

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
let invokeReady: Promise<Invoke> | null = null

function invoker(): Promise<Invoke> {
  invokeReady ??= import('@tauri-apps/api/core').then(({ invoke }) => invoke)
  return invokeReady
}

const pendingDestruction = new Map<string, Promise<void>>()

function tauriBrowserCommands(): BrowserCommands {
  const ready = invoker()
  return {
    async mount(id, url, fullscreen, rect, workspaceId) {
      await pendingDestruction.get(id)
      const invoke = await ready
      return invoke<Rect>('browser_mount', { id, url, fullscreen, rect, workspaceId })
    },
    async resize(id, rect) {
      const invoke = await ready
      return invoke<Rect>('browser_resize', { id, rect })
    },
    async setVisible(id, visible, reason) {
      const invoke = await ready
      return invoke<void>('browser_set_visible', { id, visible, reason })
    },
    destroy(id) {
      const destruction = ready.then((invoke) => invoke<void>('browser_destroy', { id }))
      pendingDestruction.set(id, destruction)
      void destruction.finally(() => {
        if (pendingDestruction.get(id) === destruction) pendingDestruction.delete(id)
      }).catch(() => {})
      return destruction
    }
  }
}

async function browserDetach(id: string): Promise<Rect> {
  const invoke = await invoker()
  return invoke<Rect>('browser_detach', { id })
}

async function browserReattach(id: string): Promise<Rect> {
  const invoke = await invoker()
  return invoke<Rect>('browser_reattach', { id })
}

export function parseCssColor(value: string): [number, number, number, number] | null {
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return [0, 0, 0, 0]
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text)
  if (rgb) {
    const parts = rgb[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean).map(Number.parseFloat)
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
    const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255, alpha]
  }
  const srgb = /^color\(\s*srgb\s+([^)]+)\)$/.exec(text)
  if (srgb) {
    const parts = srgb[1].replace(/\//g, ' ').split(/\s+/).filter(Boolean).map(Number.parseFloat)
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
    const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    return [parts[0], parts[1], parts[2], alpha]
  }
  return null
}

function resolveSurround(el: HTMLElement): [number, number, number, number] | null {
  let node: HTMLElement | null = el
  while (node) {
    const parsed = parseCssColor(getComputedStyle(node).backgroundColor)
    if (parsed && parsed[3] > 0) return parsed
    node = node.parentElement
  }
  return null
}

export function measureCorners(container: HTMLElement): CornerSpec | undefined {
  try {
    const radius = Number.parseFloat(getComputedStyle(container).borderBottomLeftRadius)
    if (!Number.isFinite(radius) || radius <= 0) return undefined
    const pane = container.closest<HTMLElement>('.pane')
    if (!pane) return undefined
    const paneStyle = getComputedStyle(pane)
    const borderWidth = Number.parseFloat(paneStyle.borderBottomWidth)
    const border = parseCssColor(paneStyle.borderBottomColor)
    const surround = pane.parentElement ? resolveSurround(pane.parentElement) : null
    if (!border || !surround) return undefined
    return {
      radius,
      borderWidth: Number.isFinite(borderWidth) && borderWidth > 0 ? borderWidth : 0,
      border,
      surround
    }
  } catch {
    return undefined
  }
}

function noopBrowserCommands(): BrowserCommands {
  const emptyRect: Rect = { x: 0, y: 0, width: 0, height: 0 }
  return {
    mount: async () => emptyRect,
    resize: async () => emptyRect,
    setVisible: async () => undefined,
    destroy: async () => undefined
  }
}

export interface UseBrowserHostOptions {
  id: string
  url: string
  fullscreen: boolean
  containerRef: React.RefObject<HTMLElement | null>
  workspaceId?: string | null
  onReady?: () => void
  onMountFailure?: (id: string) => void
  onError?: (context: 'mount' | 'resize' | 'setVisible' | 'destroy', id: string, err: unknown) => void
}

export interface UseBrowserHostResult {
  setVisible: (visible: boolean, reason: string) => Promise<void>
  remeasure: () => void
  detached: boolean
  isDetached: () => boolean
  detach: () => Promise<void>
  reattach: () => Promise<void>
}

export function useBrowserHost(options: UseBrowserHostOptions): UseBrowserHostResult {
  const { id, url, fullscreen, containerRef, workspaceId, onMountFailure, onError } = options
  const engineRef = useRef<BrowserGeometryEngine | null>(null)
  const measureRef = useRef<Measure | null>(null)
  const detachedRef = useRef(false)
  const [detached, setDetachedState] = useState(false)

  const setDetached = useCallback((value: boolean) => {
    detachedRef.current = value
    setDetachedState(value)
    notifyBrowserSurfaceRects()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const measure = (): Rect => {
      const box = container.getBoundingClientRect()
      notifyBrowserSurfaceRects()
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        corners: measureCorners(container)
      }
    }
    measureRef.current = measure

    const engine = new BrowserGeometryEngine({
      id,
      commands: isTauri() ? tauriBrowserCommands() : noopBrowserCommands(),
      workspaceId,
      onMountFailure,
      onError
    })
    engineRef.current = engine
    setDetached(false)

    void engine.mount(url, fullscreen, measure()).then(() => {
      if (engineRef.current === engine && engine.status === 'mounted') options.onReady?.()
    })

    const observer = new ResizeObserver(() => engine.onResizeObserverBurst(measure))
    observer.observe(container)

    const onWindowResize = (): void => engine.onResizeObserverBurst(measure)
    window.addEventListener('resize', onWindowResize)

    return () => {
      window.removeEventListener('resize', onWindowResize)
      observer.disconnect()
      engine.destroy()
      engineRef.current = null
      measureRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, containerRef])

  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const dispose = await listen<{ id: string }>(DETACHED_CLOSED_EVENT, (event) => {
        if (event.payload.id !== id) return
        setDetached(false)
        const engine = engineRef.current
        const measure = measureRef.current
        if (!engine || !measure) return
        void engine.mount(url, fullscreen, measure())
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, setDetached])

  const lastWorkspace = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!isTauri()) return
    const previous = lastWorkspace.current
    const next = workspaceId ?? null
    lastWorkspace.current = next
    if (previous === undefined || previous === next) return
    void (async () => {
      const invoke = await invoker()
      await invoke<void>('browser_set_workspace', { id, workspaceId: next })
    })().catch((err: unknown) => {
      console.warn(`houston: browser_set_workspace failed for id ${id}`, err)
    })
  }, [id, workspaceId])

  return {
    setVisible: (visible, reason) => {
      const engine = engineRef.current
      if (!engine) return Promise.resolve()
      return engine.setVisible(visible, reason)
    },
    remeasure: () => {
      const engine = engineRef.current
      const measure = measureRef.current
      if (!engine || !measure) return
      engine.onResizeObserverBurst(measure)
    },
    detached,
    isDetached: () => detachedRef.current,
    detach: async () => {
      if (!isTauri()) {
        throw new Error(
          `houston: browser_detach is Tauri-only; useBrowserHost(id: ${id}) called it under a ` +
            'non-Tauri host'
        )
      }
      await browserDetach(id)
      setDetached(true)
    },
    reattach: async () => {
      if (!isTauri()) {
        throw new Error(
          `houston: browser_reattach is Tauri-only; useBrowserHost(id: ${id}) called it under a ` +
            'non-Tauri host'
        )
      }
      await browserReattach(id)
      setDetached(false)
      const engine = engineRef.current
      const measure = measureRef.current
      if (engine && measure) engine.onResizeObserverBurst(measure)
    }
  }
}

export function nativeCommandErrorMessage(
  context: 'mount' | 'resize' | 'setVisible' | 'destroy',
  id: string,
  err: unknown
): string {
  const detail = err instanceof Error ? err.message : String(err)
  return `browser ${context} failed for surface ${id}: ${detail}`
}

// Keep overlay input responsive if native capture or image decoding stalls.
export const FREEZE_FRAME_TIMEOUT_MS = 250

export function useBrowserFreezeFrame(
  id: string,
  containerRef: React.RefObject<HTMLElement | null>,
  nativeSetVisible: (visible: boolean, reason: string) => Promise<void>
): (visible: boolean, reason: string) => Promise<void> {
  const freezeRef = useRef<HTMLImageElement | null>(null)
  const freezeQueue = useRef<Promise<void>>(Promise.resolve())
  const reasons = useRef(new Set<string>())
  const generation = useRef(0)
  useEffect(() => () => {
    generation.current++
    reasons.current.clear()
    freezeRef.current?.remove()
    freezeRef.current = null
  }, [id])
  const nativeVisibleRef = useRef(nativeSetVisible)
  nativeVisibleRef.current = nativeSetVisible
  const setVisible = useCallback((visible: boolean, reason: string): Promise<void> => {
    const container = containerRef.current
    const epoch = generation.current
    const command = freezeQueue.current.then(async () => {
      if (!container || containerRef.current !== container || epoch !== generation.current) return
      if (!visible && reasons.current.size === 0) {
        let expired = false
        let imageReady = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const capture = (async () => {
          try {
            const invoke = await invoker()
            const url = await invoke<string>('browser_capture_placeholder', { id })
            if (expired || epoch !== generation.current || containerRef.current !== container ||
                typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) return
            const image = document.createElement('img')
            image.alt = ''
            image.setAttribute('aria-hidden', 'true')
            Object.assign(image.style, {
              position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none'
            })
            freezeRef.current = image
            const loaded = new Promise<void>((resolve) => {
              image.onload = () => {
                imageReady = true
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              }
              image.onerror = () => {
                image.remove()
                resolve()
              }
            })
            image.src = url
            container.prepend(image)
            await loaded
          } catch {
            // The themed viewport remains visible when capture is unavailable.
          }
        })()
        await Promise.race([capture, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FREEZE_FRAME_TIMEOUT_MS)
        })])
        expired = true
        clearTimeout(timer)
        if (epoch !== generation.current) return
        if (!imageReady) {
          freezeRef.current?.remove()
          freezeRef.current = null
        }
      }
      if (containerRef.current !== container || epoch !== generation.current) return
      await nativeVisibleRef.current(visible, reason)
      if (epoch !== generation.current) return
      if (visible) reasons.current.delete(reason)
      else reasons.current.add(reason)
      if (reasons.current.size === 0) {
        freezeRef.current?.remove()
        freezeRef.current = null
      }
    })
    freezeQueue.current = command.catch(() => undefined)
    return command
  }, [id])
  return setVisible
}

import {
  setSuppressionSink,
  suppressedReasons,
  suppressedScopes,
  type SuppressionScope,
  type NativeSuppressionReason
} from '../layout/nativeSuppression'

type SetVisible = (visible: boolean, reason: string) => Promise<void>

interface RegisteredSurface {
  setVisible: SetVisible
  isDetached: () => boolean
  rect: SuppressionScope['rect']
  reasons: Set<string>
}

const rectListeners = new Set<() => void>()
const surfaces = new Map<string, RegisteredSurface>()
let installed = false

function ensureInstalled(): void {
  if (installed) return
  installed = true
  setSuppressionSink((reason: NativeSuppressionReason, visible: boolean, scope?: SuppressionScope) => {
    for (const surface of surfaces.values()) {
      apply(surface, reason, visible, scope)
      if (!scope) {
        for (const active of suppressedScopes()) apply(surface, active.reason, false, active.scope)
      }
    }
  })
}

function apply(surface: RegisteredSurface, reason: string, visible: boolean, scope?: SuppressionScope): void {
  if (surface.isDetached()) return
  const key = scope ? `${reason}:${scope.key}` : reason
  const a = surface.rect()
  const b = scope?.rect()
  const intersects = !scope || (a && b && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
  const hide = !visible && !!intersects
  if (hide === surface.reasons.has(key)) return
  if (hide) surface.reasons.add(key)
  else surface.reasons.delete(key)
  void surface.setVisible(!hide, key).catch(() => undefined)
}

export function registerBrowserSurface(
  id: string,
  setVisible: SetVisible,
  isDetached: () => boolean = () => false,
  rect: SuppressionScope['rect'] = () => null
): void {
  ensureInstalled()
  const surface = { setVisible, isDetached, rect, reasons: new Set<string>() }
  surfaces.set(id, surface)
  notifyBrowserSurfaceRects()
  if (isDetached()) return
  for (const reason of suppressedReasons()) {
    apply(surface, reason, false)
  }
  for (const { reason, scope } of suppressedScopes()) apply(surface, reason, false, scope)
}

export function unregisterBrowserSurface(id: string): void {
  surfaces.delete(id)
  notifyBrowserSurfaceRects()
}

export function __resetBrowserSurfaceRegistryForTests(): void {
  surfaces.clear()
  rectListeners.clear()
  installed = false
}

export function nativeBrowserSurfaceRects(): { x: number; y: number; width: number; height: number }[] {
  return [...surfaces.values()].flatMap(surface => {
    try {
      const rect = surface.isDetached() ? null : surface.rect()
      return rect && rect.width > 0 && rect.height > 0 &&
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ? [rect] : []
    } catch { return [] }
  })
}
export function notifyBrowserSurfaceRects(): void { rectListeners.forEach(listener => listener()) }
export function subscribeBrowserSurfaceRects(listener: () => void): () => void {
  rectListeners.add(listener)
  return () => { rectListeners.delete(listener) }
}

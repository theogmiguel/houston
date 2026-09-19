import {
  setSuppressionSink,
  suppressedReasons,
  type NativeSuppressionReason
} from '../layout/nativeSuppression'

type SetVisible = (visible: boolean, reason: string) => Promise<void>

interface RegisteredSurface {
  setVisible: SetVisible
  isDetached: () => boolean
}

const surfaces = new Map<string, RegisteredSurface>()
let installed = false

function ensureInstalled(): void {
  if (installed) return
  installed = true
  setSuppressionSink((reason: NativeSuppressionReason, visible: boolean) => {
    for (const surface of surfaces.values()) {
      if (surface.isDetached()) continue
      void surface.setVisible(visible, reason).catch(() => undefined)
    }
  })
}

export function registerBrowserSurface(
  id: string,
  setVisible: SetVisible,
  isDetached: () => boolean = () => false
): void {
  ensureInstalled()
  surfaces.set(id, { setVisible, isDetached })
  if (isDetached()) return
  for (const reason of suppressedReasons()) {
    void setVisible(false, reason).catch(() => undefined)
  }
}

export function unregisterBrowserSurface(id: string): void {
  surfaces.delete(id)
}

export function __resetBrowserSurfaceRegistryForTests(): void {
  surfaces.clear()
  installed = false
}

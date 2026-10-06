import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { isTauri } from '../houston/host'
import { useBrowserHost, useBrowserFreezeFrame } from '../houston/browserHost'
import {
  registerBrowserSurface,
  unregisterBrowserSurface
} from '../houston/browserSurfaceRegistry'
import type { NativeSuppressionReason } from '../layout/nativeSuppression'
import { BrowserDetachedPlaceholder, BrowserWebviewSurface } from './ui/BrowserSurface'

async function invoker(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke
}

async function browserNavigate(id: string, url: string): Promise<void> {
  const invoke = await invoker()
  await invoke<void>('browser_navigate', { id, url })
}

export interface BrowserViewportProps {
  id: string
  url: string
  workspaceDir?: string | null
  overlay?: React.ReactNode
  fullscreen?: boolean
  rounded?: boolean
  style?: React.CSSProperties
  hidden?: boolean
  dropzoneActive?: boolean
  nonBrowserView?: boolean
  noActiveTab?: boolean
  exemptFromReason?: NativeSuppressionReason
  onDetachedChange?: (detached: boolean) => void
  onReady?: () => void
  onMountFailure?: (id: string) => void
  onError?: (
    context: 'mount' | 'resize' | 'setVisible' | 'destroy',
    id: string,
    err: unknown
  ) => void
  children: React.ReactNode
}

export interface BrowserViewportHandle {
  remeasure: () => void
  detach: () => Promise<void>
  reattach: () => Promise<void>
}

// Applied straight to THIS surface's `setVisible` instead of through
// `nativeSuppression.ts`'s reason-scoped sink: asserting a reason globally would
// hide every live browser surface, not just the one this prop is about.
function useIdScopedSuppression(
  active: boolean | undefined,
  reason: NativeSuppressionReason,
  setVisible: (visible: boolean, reason: string) => Promise<void>
): void {
  const prev = useRef(false)
  useEffect(() => {
    if (!isTauri()) return
    const next = active ?? false
    if (next === prev.current) return
    prev.current = next
    void setVisible(!next, reason)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reason])
}

export const BrowserViewport = forwardRef<BrowserViewportHandle, BrowserViewportProps>(
  function BrowserViewport(
    {
      id,
      url,
      workspaceDir = null,
      overlay,
      fullscreen = false,
      rounded = false,
      style,
      hidden,
      dropzoneActive,
      nonBrowserView,
      noActiveTab,
      exemptFromReason,
      onDetachedChange,
      onReady,
      onMountFailure,
      onError,
      children
    },
    handleRef
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const { setVisible: nativeSetVisible, remeasure, detached, isDetached, detach, reattach } = useBrowserHost({
      id,
      url,
      fullscreen,
      containerRef,
      workspaceId: workspaceDir,
      onReady,
      onMountFailure,
      onError
    })

    const setVisible = useBrowserFreezeFrame(id, containerRef, nativeSetVisible)

    useImperativeHandle(handleRef, () => ({ remeasure, detach, reattach }), [
      remeasure,
      detach,
      reattach
    ])

    const lastDetachedRef = useRef<boolean | null>(null)
    useEffect(() => {
      if (lastDetachedRef.current === detached) return
      lastDetachedRef.current = detached
      onDetachedChange?.(detached)
    }, [detached, onDetachedChange])

    // The surface whose OWN fullscreen assertion is global must not hide for it:
    // it is the one fullscreen just repositioned INTO view, not an "other" pane.
    useEffect(() => {
      if (!isTauri()) return undefined
      const guarded: typeof setVisible = (visible, reason) => {
        if (exemptFromReason && reason === exemptFromReason && visible === false) {
          return Promise.resolve()
        }
        return setVisible(visible, reason)
      }
      registerBrowserSurface(id, guarded, isDetached, () => containerRef.current?.getBoundingClientRect() ?? null)
      return () => unregisterBrowserSurface(id)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, exemptFromReason])

    useIdScopedSuppression(hidden, 'collapsed', setVisible)
    useIdScopedSuppression(dropzoneActive, 'animating', setVisible)
    useIdScopedSuppression(nonBrowserView, 'non-browser-view', setVisible)
    useIdScopedSuppression(noActiveTab, 'no-active-tab', setVisible)

    const initialUrl = useRef(url)
    useEffect(() => {
      if (!isTauri()) return
      if (url === initialUrl.current) return
      initialUrl.current = url
      void browserNavigate(id, url).catch((err: unknown) => {
        console.warn(`houston: browser_navigate failed for id ${id}`, err)
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url])

    if (!isTauri())
      return (
        <BrowserWebviewSurface rounded={rounded} style={{ position: 'relative', ...style }}>
          {children}
          {overlay}
        </BrowserWebviewSurface>
      )

    return (
      <BrowserWebviewSurface
        ref={containerRef}
        rounded={rounded}
        native
        style={{ position: 'relative', ...style }}
        data-browser-surface-id={id}
        data-browser-detached={detached || undefined}
      >
        {overlay}
        {detached && (
          <BrowserDetachedPlaceholder
            onReattach={() => {
              void reattach().catch((err: unknown) => {
                console.warn(`houston: browser_reattach failed for id ${id}`, err)
              })
            }}
          />
        )}
      </BrowserWebviewSurface>
    )
  }
)

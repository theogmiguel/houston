import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { isTauri } from '../houston/host'
import { useBrowserState, type BrowserState } from '../houston/browserState'
import type { WebviewEl } from '../houston/browserUrl'
import { nextFailMsg, pushRecent, tauriBrowserInvoke, toNavUrl, type BrowserTab } from './browserTabs'

function runBrowserAction(tauriCall: () => void, webviewCall: () => void): void {
  if (isTauri()) tauriCall()
  else webviewCall()
}

export interface BrowserNavHandle {
  browserState: BrowserState | null
  goBack: () => void
  goForward: () => void
  reload: (hard?: boolean) => void
  openUrl: (raw: string) => void
}

export function useBrowserNav(
  surfaceId: string,
  hostRef: RefObject<HTMLDivElement | null>,
  tabs: BrowserTab[],
  active: BrowserTab,
  patchTab: (id: number, patch: Partial<BrowserTab>) => void,
  setUrlInput: Dispatch<SetStateAction<string>>,
  setFailMsg: Dispatch<SetStateAction<string | null>>,
  setRecents: Dispatch<SetStateAction<string[]>>
): BrowserNavHandle {
  const browserState = useBrowserState(surfaceId)

  const stateFailMsg = useRef<string | null>(null)

  useEffect(() => {
    if (!browserState || active.url === null) return
    const patch: Partial<BrowserTab> = {
      loading: browserState.loading,
      canGoBack: browserState.canGoBack,
      canGoForward: browserState.canGoForward,
      progress: browserState.progress
    }
    if (browserState.title != null) patch.title = browserState.title
    if (browserState.favicon != null) patch.favicon = browserState.favicon
    if (browserState.url != null && browserState.url !== active.url) {
      patch.url = browserState.url
      setUrlInput(browserState.url)
    }
    patchTab(active.id, patch)
    const fromState = browserState.error?.message ?? null
    setFailMsg((prev) => nextFailMsg(prev, stateFailMsg.current, fromState))
    stateFailMsg.current = fromState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserState, active.id, active.url])

  const activeWebview = (): (WebviewEl & { __ready?: () => boolean }) | null => {
    const views = hostRef.current?.querySelectorAll('webview[data-browser-tab]')
    if (!views) return null
    const withUrl = tabs.filter((t) => t.url !== null)
    const idx = withUrl.findIndex((t) => t.id === active.id)
    return idx >= 0 ? ((views[idx] as WebviewEl & { __ready?: () => boolean }) ?? null) : null
  }

  const withWebview = (fn: (wv: WebviewEl) => void): void => {
    const wv = activeWebview()
    if (wv && wv.__ready?.()) fn(wv)
  }

  const goBack = (): void =>
    runBrowserAction(
      () => void tauriBrowserInvoke('browser_go_back', { id: surfaceId }),
      () => withWebview((wv) => wv.goBack())
    )

  const goForward = (): void =>
    runBrowserAction(
      () => void tauriBrowserInvoke('browser_go_forward', { id: surfaceId }),
      () => withWebview((wv) => wv.goForward())
    )

  const reload = (hard: boolean = false): void =>
    runBrowserAction(
      () => void tauriBrowserInvoke('browser_reload', { id: surfaceId, bypassCache: hard }),
      () =>
        withWebview((wv) =>
          hard
            ? (wv as WebviewEl & { reloadIgnoringCache?: () => void }).reloadIgnoringCache?.()
            : wv.reload()
        )
    )

  const openUrl = (raw: string): void => {
    const url = toNavUrl(raw)
    setUrlInput(url)
    setRecents(pushRecent(url))
    setFailMsg(null)
    if (active.url === null) {
      patchTab(active.id, { url })
      return
    }
    runBrowserAction(
      () => patchTab(active.id, { url }),
      () => withWebview((wv) => void wv.loadURL(url))
    )
  }

  return { browserState, goBack, goForward, reload, openUrl }
}

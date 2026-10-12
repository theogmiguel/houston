import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction
} from 'react'
import { isTauri } from '../houston/host'
import { useBrowserState, type BrowserState } from '../houston/browserState'
import { nextFailMsg, pushRecent, tauriBrowserInvoke, toNavUrl, type BrowserTab } from './browserTabs'

export type BrowserPageState = Omit<BrowserTab, 'id'>

export interface BrowserNavHandle {
  browserState: BrowserState | null
  goBack: () => void
  goForward: () => void
  reload: (hard?: boolean) => void
  openUrl: (raw: string) => void
}

export function useBrowserNav(
  surfaceId: string,
  active: BrowserPageState,
  patchPage: (patch: Partial<BrowserPageState>) => void,
  setUrlInput: Dispatch<SetStateAction<string>>,
  setFailMsg: Dispatch<SetStateAction<string | null>>,
  setRecents: Dispatch<SetStateAction<string[]>>
): BrowserNavHandle {
  const browserState = useBrowserState(surfaceId)

  const stateFailMsg = useRef<string | null>(null)

  useEffect(() => {
    if (!browserState || active.url === null) return
    const patch: Partial<BrowserPageState> = {
      loading: browserState.loading,
      canGoBack: browserState.canGoBack,
      canGoForward: browserState.canGoForward,
      progress: browserState.progress
    }
    if (browserState.title != null) patch.title = browserState.title
    if (browserState.favicon != null) patch.favicon = browserState.favicon
    if (!browserState.loading && browserState.url != null && browserState.url !== active.url) {
      patch.url = browserState.url
      setUrlInput(browserState.url)
    }
    patchPage(patch)
    const fromState = browserState.error?.message ?? null
    setFailMsg((prev) => nextFailMsg(prev, stateFailMsg.current, fromState))
    stateFailMsg.current = fromState
    // A requested URL must not replay the previous native state before navigation starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserState])

  const goBack = (): void => { if (isTauri()) void tauriBrowserInvoke('browser_go_back', {id: surfaceId}) }
  const goForward = (): void => { if (isTauri()) void tauriBrowserInvoke('browser_go_forward', {id: surfaceId}) }
  const reload = (hard = false): void => { if (isTauri()) void tauriBrowserInvoke('browser_reload', {id: surfaceId, bypassCache: hard}) }

  const openUrl = (raw: string): void => {
    const url = toNavUrl(raw)
    setUrlInput(url)
    setRecents(pushRecent(url))
    setFailMsg(null)
    patchPage({url})
  }

  return { browserState, goBack, goForward, reload, openUrl }
}

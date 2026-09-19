import {
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { BORDER_HAIRLINE_INSET } from './shadowChrome'
import { normalizeUrl, type WebviewEl } from '../houston/browserUrl'
import { addNotification } from '../notificationStore'
import { GridHiddenContext } from '../layout/gridHiddenContext'
import { useBrowserOpenUrl } from '../houston/browserState'
import { IconClose, IconPlus } from './icons'
import { WEBVIEW_HOST_CLS } from './panelChrome'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'
import { HIT_TARGET_28 } from './hitTarget'

const RECENTS_KEY = 'tr-browser-recents'
// Kept at 8 deliberately: raising it decides how much browsing history Houston
// retains, which is a privacy question, not an autocomplete one.
const RECENTS_CAP = 8

export function loadRecents(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter(isRestorableUrl) : []
  } catch {
    return []
  }
}

export function clearRecents(): void {
  localStorage.removeItem(RECENTS_KEY)
}

export function pushRecent(url: string): string[] {
  const next = [url, ...loadRecents().filter((u) => u !== url)].slice(0, RECENTS_CAP)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  return next
}

const TABS_KEY = 'tr-browser-tabs.v1'
// Bounds more than strip width: each restored tab mounts its own guest webview at
// launch, so this caps concurrent processes, not pixels.
export const TABS_CAP = 50

export async function tauriBrowserInvoke(cmd: string, args: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke<void>(cmd, args)
  } catch (err) {
    console.warn(`houston: ${cmd} failed`, err)
  }
}

export function isRestorableUrl(u: unknown): u is string {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false
  try {
    return new URL(u).hostname.length > 0
  } catch {
    return false
  }
}

export const POPUP_URL_MAX = 4096

function shortUrl(raw: string): string {
  const shown = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
  return JSON.stringify(shown)
}

export function persistedTabCount(tabs: readonly BrowserTab[]): number {
  return tabs.filter((t) => isRestorableUrl(t.url)).length
}

export function popupTabDecision(
  surfaceCurrent: boolean,
  tabCount: number,
  raw: unknown
): { url: string } | { refused: string } {
  if (typeof raw !== 'string') {
    return { refused: `Blocked a popup: the host sent no URL to open (got ${typeof raw}).` }
  }
  if (!surfaceCurrent) {
    return {
      refused: `Blocked a popup: this browser is not on screen, so ${shortUrl(raw)} was not opened. Open the browser and try the link again.`
    }
  }
  if (raw.length > POPUP_URL_MAX) {
    return {
      refused: `Blocked a popup: its URL is ${raw.length} characters, over the ${POPUP_URL_MAX}-character limit (${shortUrl(raw)}).`
    }
  }
  if (!isRestorableUrl(raw)) {
    return {
      refused: `Blocked a popup: ${shortUrl(raw)} is not an http(s) address with a host.`
    }
  }
  if (tabCount >= TABS_CAP) {
    return {
      refused: `Blocked a popup: this browser already has ${tabCount} saved tabs (limit ${TABS_CAP}). Close one to open ${shortUrl(raw)}.`
    }
  }
  return { url: raw }
}

export function announcePopupRefusal(
  surfaceId: string,
  text: string,
  onAppError?: (text: string) => void
): void {
  console.warn(`houston: ${text} (surface ${JSON.stringify(surfaceId)})`)
  const record = addNotification({
    agentId: `browser:${surfaceId}`,
    kind: 'browser-popup-blocked',
    title: 'Popup blocked',
    dir: '',
    text
  })
  if (record) onAppError?.(text)
}

export function nextFailMsg(
  prev: string | null,
  prevFromState: string | null,
  next: string | null
): string | null {
  return prev === null || prev === prevFromState ? next : prev
}

export interface BrowserTab {
  id: number
  url: string | null
  title?: string
  favicon?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  progress?: number
}

export function filterRecents(recents: string[], input: string): string[] {
  const q = input.trim().toLowerCase()
  if (q === '') return []
  return recents.filter((u) => u.toLowerCase().includes(q) && u.toLowerCase() !== q)
}

export function defaultTabs(): { tabs: BrowserTab[]; activeTabId: number } {
  return { tabs: [{ id: 1, url: null }], activeTabId: 1 }
}

export function loadTabs(key: string = TABS_KEY): { tabs: BrowserTab[]; activeTabId: number } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (raw === null || typeof raw !== 'object') return defaultTabs()
    const { tabs, activeTabId } = raw as { tabs?: unknown; activeTabId?: unknown }
    if (!Array.isArray(tabs)) return defaultTabs()
    const restored: BrowserTab[] = tabs
      .filter(
        (t): t is { id: number; url: string } =>
          typeof t === 'object' &&
          t !== null &&
          Number.isInteger((t as { id?: unknown }).id) &&
          isRestorableUrl((t as { url?: unknown }).url)
      )
      .map((t) => ({ id: t.id, url: t.url }))
    const seen = new Set<number>()
    const unique = restored.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, TABS_CAP)
    if (unique.length === 0) return defaultTabs()
    const active = unique.some((t) => t.id === activeTabId)
      ? (activeTabId as number)
      : unique[0].id
    return { tabs: unique, activeTabId: active }
  } catch {
    return defaultTabs()
  }
}

export function saveTabs(
  tabs: BrowserTab[],
  activeTabId: number,
  key: string = TABS_KEY
): string | null {
  const persistable = tabs
    .filter((t) => isRestorableUrl(t.url))
    .slice(0, TABS_CAP)
    .map((t) => ({ id: t.id, url: t.url }))
  const payload = JSON.stringify({ tabs: persistable, activeTabId })
  try {
    localStorage.setItem(key, payload)
    return null
  } catch (err) {
    return `Open tabs won't be restored — writing ${payload.length} bytes to browser storage failed (${
      err instanceof Error ? err.message : String(err)
    }).`
  }
}

export interface BrowserTabsHandle {
  tabs: BrowserTab[]
  active: BrowserTab
  persistError: string | null
  patchTab: (id: number, patch: Partial<BrowserTab>) => void
  selectTab: (t: BrowserTab) => void
  newTab: () => void
  closeTab: (id: number) => void
  openPopupTab: (url: string) => void
}

export function useBrowserTabs(
  surfaceId: string,
  tabsKey: string,
  restored: { tabs: BrowserTab[]; activeTabId: number },
  opts: {
    hiddenByExpand: boolean | undefined
    onNativeError: ((text: string) => void) | undefined
    setUrlInput: Dispatch<SetStateAction<string>>
    setFailMsg: Dispatch<SetStateAction<string | null>>
  }
): BrowserTabsHandle {
  const { hiddenByExpand, onNativeError, setUrlInput, setFailMsg } = opts
  const [tabs, setTabs] = useState<BrowserTab[]>(restored.tabs)
  const [activeTab, setActiveTab] = useState(restored.activeTabId)
  const tabSeq = useRef(restored.tabs.reduce((max, t) => Math.max(max, t.id), 0))
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const gridHidden = useContext(GridHiddenContext)

  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0]

  const [persistError, setPersistError] = useState<string | null>(null)
  useEffect(() => setPersistError(saveTabs(tabs, activeTab, tabsKey)), [tabs, activeTab, tabsKey])

  const patchTab = (id: number, patch: Partial<BrowserTab>): void => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  const selectTab = (t: BrowserTab): void => {
    setActiveTab(t.id)
    setUrlInput(t.url ?? '')
    setFailMsg(null)
  }

  const newTab = (): void => {
    const id = ++tabSeq.current
    setTabs((prev) => [...prev, { id, url: null }])
    setActiveTab(id)
    setUrlInput('')
    setFailMsg(null)
  }

  const openPopupTab = (url: string): void => {
    const decision = popupTabDecision(
      !hiddenByExpand && !gridHidden,
      persistedTabCount(tabsRef.current),
      url
    )
    if ('refused' in decision) {
      announcePopupRefusal(surfaceId, decision.refused, onNativeError)
      return
    }
    const id = ++tabSeq.current
    const tab: BrowserTab = { id, url: decision.url }
    tabsRef.current = [...tabsRef.current, tab]
    setTabs((prev) => [...prev, tab])
    setActiveTab(id)
    setUrlInput(decision.url)
    setFailMsg(null)
  }
  useBrowserOpenUrl(surfaceId, openPopupTab)

  const closeTab = (id: number): void => {
    const remaining = tabs.filter((t) => t.id !== id)
    if (remaining.length === 0) {
      const fresh: BrowserTab = { id: ++tabSeq.current, url: null }
      setTabs([fresh])
      setActiveTab(fresh.id)
      setUrlInput('')
      return
    }
    setTabs(remaining)
    if (id === activeTab) {
      const next = remaining[remaining.length - 1]
      setActiveTab(next.id)
      setUrlInput(next.url ?? '')
    }
  }

  return { tabs, active, persistError, patchTab, selectTab, newTab, closeTab, openPopupTab }
}

export function hostLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url
  }
}

export function faviconInitial(url: string | null): string {
  if (!url) return '·'
  const h = hostLabel(url).replace(/^www\./, '')
  return (h[0] ?? '·').toUpperCase()
}

function faviconSrc(t: BrowserTab): string | null {
  return t.favicon ?? null
}

export function toNavUrl(raw: string): string {
  const t = raw.trim()
  if (/^https?:\/\//i.test(t)) return t
  if (!/\s/.test(t) && (t.includes('.') || t.includes(':'))) return normalizeUrl(t)
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

export function TabWebview({
  url,
  visible,
  onNavigate,
  onMeta,
  onLoading,
  onFail
}: {
  url: string
  visible: boolean
  onNavigate: (url: string, canGoBack: boolean, canGoForward: boolean) => void
  onMeta: (meta: Partial<Pick<BrowserTab, 'title' | 'favicon'>>) => void
  onLoading: (loading: boolean) => void
  onFail: (desc: string | null) => void
}): React.JSX.Element {
  const webviewRef = useRef<WebviewEl | null>(null)
  const readyRef = useRef(false)
  const initialUrl = useRef(url)
  const cb = useRef({ onNavigate, onMeta, onLoading, onFail })
  cb.current = { onNavigate, onMeta, onLoading, onFail }

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    type NavHost = { canGoBack?: () => boolean; canGoForward?: () => boolean }
    const onReady = (): void => {
      readyRef.current = true
    }
    const onDidNavigate = (e: Event): void => {
      const navUrl = (e as Event & { url?: string }).url
      const nav = wv as unknown as NavHost
      if (navUrl)
        cb.current.onNavigate(navUrl, nav.canGoBack?.() ?? false, nav.canGoForward?.() ?? false)
    }
    const onTitle = (e: Event): void => {
      const title = (e as Event & { title?: string }).title
      if (title) cb.current.onMeta({ title })
    }
    const onFavicon = (e: Event): void => {
      const favicons = (e as Event & { favicons?: string[] }).favicons
      if (favicons?.[0]) cb.current.onMeta({ favicon: favicons[0] })
    }
    const onStart = (): void => {
      cb.current.onLoading(true)
      cb.current.onFail(null)
    }
    const onStop = (): void => cb.current.onLoading(false)
    const onFailLoad = (e: Event): void => {
      const f = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (f.isMainFrame && f.errorCode !== undefined && f.errorCode !== -3)
        cb.current.onFail(f.errorDescription || `Load failed (${f.errorCode})`)
    }
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-navigate', onDidNavigate)
    wv.addEventListener('did-navigate-in-page', onDidNavigate)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('page-favicon-updated', onFavicon)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-fail-load', onFailLoad)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-navigate', onDidNavigate)
      wv.removeEventListener('did-navigate-in-page', onDidNavigate)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('page-favicon-updated', onFavicon)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-fail-load', onFailLoad)
    }
  }, [])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    ;(wv as WebviewEl & { __ready?: () => boolean }).__ready = () => readyRef.current
  }, [])

  return (
    <webview
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref={webviewRef as any}
      className={WEBVIEW_HOST_CLS}
      style={visible ? undefined : { display: 'none' }}
      src={initialUrl.current}
      data-browser-tab
    />
  )
}

export function TabsPopover({
  tabs,
  activeId,
  onSelect,
  onCloseTab,
  onNewTab,
  onDismiss
}: {
  tabs: BrowserTab[]
  activeId: number
  onSelect: (t: BrowserTab) => void
  onCloseTab: (id: number) => void
  onNewTab: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  return (
    <div
      ref={ref}
      className="absolute top-[calc(100%_+_6px)] right-0 z-[var(--z-sticky)] min-w-[260px] max-w-[320px] p-1 rounded-lg bg-surface border border-border shadow-[var(--shadow-1)] motion-safe:[animation:menu-in_var(--animate-t-fast)_var(--animate-ease-menu)]"
      role="menu"
    >
      <div className="flex flex-col gap-px max-h-[360px] overflow-y-auto [scrollbar-width:thin]">
        {tabs.map((t) => {
          const title = t.title?.trim() || (t.url ? hostLabel(t.url) : 'New tab')
          return (
            <div
              key={t.id}
              className={`group/pop relative flex items-center gap-0.5 rounded-md text-text-secondary [transition:background_0.12s_ease,color_0.12s_ease] hover:bg-background hover:text-text-primary data-[active]:bg-background data-[active]:text-text-primary data-[active]:shadow-[${BORDER_HAIRLINE_INSET}]`}
              data-active={t.id === activeId || undefined}
              data-loading={t.loading || undefined}
              role="none"
            >
              <Tooltip label={t.url ?? undefined}>
                <button
                  aria-label={t.url ?? undefined}
                  type="button"
                  role="menuitemradio"
                  aria-checked={t.id === activeId}
                  className="btn flex-1 min-w-0 flex items-center gap-2 py-1.5 pr-1.5 pl-2 border-0 rounded-[var(--tr-radius-sm)] bg-transparent text-inherit text-left"
                  onClick={() => {
                    onSelect(t)
                    onDismiss()
                  }}
                >
                  {}
                  <span
                    className="relative flex-none inline-flex items-center justify-center w-[18px] h-[18px] rounded-[4px] bg-surface-hover text-text-secondary font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] overflow-hidden uppercase [--dot-pulse-opacity:0.45] group-data-[loading]/pop:loop-anim group-data-[loading]/pop:motion-safe:[animation:dot-pulse_1.2s_ease-in-out_infinite] group-data-[loading]/pop:motion-reduce:opacity-70"
                    aria-hidden
                  >
                    {t.url === null ? (
                      <Icon glyph={IconPlus} role="label" />
                    ) : (
                      <>
                        <span className="absolute inset-0 flex items-center justify-center">
                          {faviconInitial(t.url)}
                        </span>
                        {faviconSrc(t) && (
                          <img
                            className="absolute inset-0 w-full h-full object-contain bg-[inherit]"
                            src={faviconSrc(t) as string}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                        )}
                      </>
                    )}
                  </span>
                  <span className="flex-1 min-w-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] overflow-hidden text-ellipsis whitespace-nowrap">
                    {title}
                  </span>
                </button>
              </Tooltip>
              {}
              <button
                type="button"
                aria-label={`Close ${title}`}
                className={`btn flex-none inline-flex items-center justify-center w-[18px] h-[18px] rounded-[var(--tr-radius-input)] text-[color-mix(in_srgb,currentColor_55%,transparent)] bg-transparent border-0 p-0 opacity-0 [transition:opacity_0.12s_ease,color_0.12s_ease,background_0.12s_ease] group-hover/pop:opacity-100 group-focus-within/pop:opacity-100 group-data-[active]/pop:opacity-100 hover:text-text-primary hover:bg-[color-mix(in_srgb,var(--text-primary)_12%,transparent)] ${HIT_TARGET_28}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(t.id)
                }}
              >
                <Icon glyph={IconClose} role="label" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        data-testid="browser-new-tab"
        className="btn flex items-center gap-2 w-full mt-1 py-[7px] px-2.5 rounded-[var(--tr-radius-button)] bg-transparent border border-dashed border-border text-text-secondary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] [transition:color_0.14s_ease,background_0.14s_ease,border-color_0.14s_ease] hover:text-text-primary hover:border-[var(--text-muted)] hover:bg-background [&>span]:flex-1 [&>span]:text-left"
        onClick={() => {
          onNewTab()
          onDismiss()
        }}
      >
        <Icon glyph={IconPlus} role="ui" />
        <span>New tab</span>
      </button>
    </div>
  )
}

import { normalizeUrl } from '../houston/browserUrl'
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
  onAppError?.(text)
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

export function toNavUrl(raw: string): string {
  const t = raw.trim()
  if (/^https?:\/\//i.test(t)) return t
  if (!/\s/.test(t) && (t.includes('.') || t.includes(':'))) return normalizeUrl(t)
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

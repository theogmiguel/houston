import { useEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { openExternal } from '../../houston/bridge'
import { Icon } from '../ui/Icon'
import { ShellBrowserRoot, ShellElement } from '../ui/ShellPrimitives'
import { BrowserViewport, type BrowserViewportHandle } from '../BrowserViewport'
import {
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconClose,
  IconExternal,
  IconMonitor,
  IconRefresh,
  IconSearch,
} from '../icons'
import { useBrowserTabs, TabWebview, loadTabs, toNavUrl, type BrowserTab } from '../browserTabs'
import { useBrowserNav } from '../browserNav'
import { tabsStorageKey } from '../browserTabsKey'
import { useBrowserPaneLocalServers } from '../browserPaneLocalServers'
import '../ui/browserSurface.css'

interface RecentEntry {
  url: string
  title: string
  favicon: string | null
}

const RECENT_LIMIT = 5

export interface BrowserSurfaceProps {
  workspace: string
  tabId: string
  active: boolean
  onTitleChange(title: string, faviconUrl: string | null): void
  client?: HoustonClient
  onFocusPane?: (session: number) => void
}

function localRecentKey(workspace: string): string {
  return `tr-browser-recents:${workspace}`
}

function readRecents(workspace: string): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(localRecentKey(workspace)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is RecentEntry =>
        Boolean(entry && typeof entry === 'object' && typeof entry.url === 'string' && typeof entry.title === 'string'),
      )
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

function addressUrl(input: string): string {
  const value = input.trim()
  if (/^https?:\/\//i.test(value)) return value
  if (/^(localhost|127\.)/i.test(value)) return `http://${value}`
  if (/\s/.test(value) || (!value.includes('.') && !value.includes(':'))) return toNavUrl(value)
  return `https://${value}`
}

function serverUrl(port: number): string {
  return `http://localhost:${port}`
}

function addressDisplayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

export function BrowserSurface({
  workspace,
  tabId,
  active: isActive,
  onTitleChange,
  client,
  onFocusPane,
}: BrowserSurfaceProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<BrowserViewportHandle>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const tabsKey = tabsStorageKey(tabId)
  const [restored] = useState(() => loadTabs(tabsKey))
  const [urlInput, setUrlInput] = useState(
    () => restored.tabs.find((tab) => tab.id === restored.activeTabId)?.url ?? '',
  )
  const [addressFocused, setAddressFocused] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>(() => readRecents(workspace))
  const [serversMenu, setServersMenu] = useState(false)
  const tabs = useBrowserTabs(tabId, tabsKey, restored, {
    hiddenByExpand: !isActive,
    onNativeError: undefined,
    setUrlInput,
    setFailMsg,
  })
  const { tabs: openTabs, active, patchTab } = tabs
  const localServers = useBrowserPaneLocalServers(client, workspace, true, !isActive, false)
  const nav = useBrowserNav(tabId, hostRef, openTabs, active, patchTab, setUrlInput, setFailMsg, () => {})
  const title = active.title?.trim() || (active.url ? new URL(active.url).hostname : 'New tab')

  useEffect(() => {
    onTitleChange(title, active.favicon ?? null)
  }, [active.favicon, onTitleChange, title])

  useEffect(() => {
    if (active.url === null) return
    const next = [
      { url: active.url, title: active.title?.trim() || active.url, favicon: active.favicon ?? null },
      ...recents.filter((entry) => entry.url !== active.url),
    ].slice(0, RECENT_LIMIT)
    setRecents(next)
    localStorage.setItem(localRecentKey(workspace), JSON.stringify(next))
  }, [active.favicon, active.title, active.url, workspace])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const remeasure = (): void => {
      requestAnimationFrame(() => viewportRef.current?.remeasure())
    }
    const onTransitionEnd = (event: Event): void => {
      const target = event.target
      if (target instanceof Element && (target === host || target.contains(host))) remeasure()
    }
    document.addEventListener('transitionend', onTransitionEnd, true)
    document.addEventListener('animationend', onTransitionEnd, true)
    return () => {
      document.removeEventListener('transitionend', onTransitionEnd, true)
      document.removeEventListener('animationend', onTransitionEnd, true)
    }
  }, [])

  useEffect(() => {
    window.requestAnimationFrame(() => viewportRef.current?.remeasure())
  }, [isActive])

  const loading = Boolean(active.loading)
  const favicon = active.favicon
  const recentRows = useMemo(() => recents.slice(0, RECENT_LIMIT), [recents])

  const navigate = (value: string): void => {
    const url = addressUrl(value)
    nav.openUrl(url)
  }

  return (
    <ShellBrowserRoot ref={hostRef} data-active={isActive || undefined}>
      <ShellElement as="div" shellRole="browser-toolbar">
        <button aria-label="Back" disabled={!isActive || !active.canGoBack} onClick={nav.goBack}>
          <Icon glyph={IconChevronLeft} role="ui" />
        </button>
        <button aria-label="Forward" disabled={!isActive || !active.canGoForward} onClick={nav.goForward}>
          <Icon glyph={IconChevronRight} role="ui" />
        </button>
        <button aria-label="Reload" disabled={!isActive || !active.url} onClick={() => nav.reload()}>
          <Icon glyph={IconRefresh} role="ui" />
        </button>
        <ShellElement as="label" shellRole="browser-address">
          {favicon ? (
            <img src={favicon} alt="" />
          ) : active.url ? (
            <ShellElement as="span" shellRole="browser-favicon">{title.slice(0, 1).toUpperCase()}</ShellElement>
          ) : (
            <Icon glyph={IconSearch} role="label" />
          )}
          <input
            ref={addressRef}
            aria-label="Address"
            placeholder="Search or enter URL"
            value={addressFocused ? urlInput : addressDisplayUrl(urlInput)}
            disabled={!isActive}
            spellCheck={false}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onChange={(event) => setUrlInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate(urlInput)
            }}
          />
        </ShellElement>
        <ShellElement as="div" shellRole="browser-server-menu">
          <ShellElement
            as="button"
            shellRole="browser-server-button"
            aria-label="Local servers"
            aria-expanded={serversMenu}
            disabled={!isActive}
            onClick={() => setServersMenu((open) => !open)}
          >
            <Icon glyph={IconMonitor} role="ui" />
            <ShellElement as="span" shellRole="browser-count">{localServers.servers.length}</ShellElement>
          </ShellElement>
          {serversMenu && (
            <ShellElement as="div" shellRole="browser-menu" role="menu">
              <ShellElement as="div" shellRole="browser-menu-label">Local servers</ShellElement>
              {localServers.servers.map((server) => (
                <button
                  key={`${server.session}:${server.port}`}
                  role="menuitem"
                  onClick={() => {
                    navigate(serverUrl(server.port))
                    setServersMenu(false)
                  }}
                >
                  <ShellElement as="span" shellRole="browser-favicon">{server.pane_title.slice(0, 1).toUpperCase()}</ShellElement>
                  <ShellElement as="span" shellRole="browser-menu-url">localhost:{server.port}</ShellElement>
                  <ShellElement as="span" shellRole="browser-process">{server.process}</ShellElement>
                </button>
              ))}
              {localServers.unsupported && <ShellElement as="div" shellRole="browser-menu-empty">{localServers.unsupported}</ShellElement>}
            </ShellElement>
          )}
        </ShellElement>
        <button
          aria-label="Open in system browser"
          disabled={!isActive || !active.url}
          onClick={() =>
            active.url &&
            void openExternal(active.url).catch((error: unknown) => console.warn('houston: openExternal failed', error))
          }
        >
          <Icon glyph={IconExternal} role="ui" />
        </button>
      </ShellElement>
      <ShellElement as="div" shellRole="browser-load">{loading && <span />}</ShellElement>
      {active.url ? (
        <BrowserViewport
          ref={viewportRef}
          id={tabId}
          url={active.url}
          workspaceDir={workspace}
          hidden={!isActive}
          noActiveTab={active.url === null}
        >
          {openTabs
            .filter((tab) => tab.url !== null)
            .map((tab: BrowserTab) => (
              <TabWebview
                key={tab.id}
                url={tab.url as string}
                visible={tab.id === active.id}
                onNavigate={(url, canGoBack, canGoForward) => {
                  patchTab(tab.id, { url, canGoBack, canGoForward })
                  if (tab.id === active.id) setUrlInput(url)
                }}
                onMeta={(meta) => patchTab(tab.id, meta)}
                onLoading={(isLoading) => patchTab(tab.id, { loading: isLoading })}
                onFail={setFailMsg}
              />
            ))}
        </BrowserViewport>
      ) : (
        <ShellElement as="div" shellRole="browser-empty">
          <ShellElement as="div" shellRole="browser-content">
            <ShellElement as="section" shellRole="browser-section">
              <h2>
                <ShellElement as="span" shellRole="browser-live" />
                Local servers
              </h2>
              <ShellElement as="div" shellRole="browser-cards">
                {localServers.servers.map((server) => (
                  <ShellElement
                    as="div"
                    shellRole="browser-card"
                    key={`${server.session}:${server.port}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open localhost:${server.port}`}
                    onClick={() => navigate(serverUrl(server.port))}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' '))
                        navigate(serverUrl(server.port))
                    }}
                  >
                    <ShellElement as="span" shellRole="browser-favicon">{server.pane_title.slice(0, 1).toUpperCase()}</ShellElement>
                    <ShellElement as="span" shellRole="browser-card-meta">
                      <ShellElement as="span" shellRole="browser-url">localhost:{server.port}</ShellElement>
                      <ShellElement as="span" shellRole="browser-sub">
                        {server.process} · started by{' '}
                        <ShellElement
                          as="button"
                          shellRole="browser-pane-chip"
                          aria-label={`Focus ${server.pane_title}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            onFocusPane?.(server.session)
                          }}
                        >
                          {server.pane_title}
                        </ShellElement>
                      </ShellElement>
                    </ShellElement>
                    <Icon glyph={IconChevronRight} role="label" />
                  </ShellElement>
                ))}
              </ShellElement>
              <ShellElement as="p" shellRole="browser-hint">Servers started by panes in this workspace. Select one to open it here.</ShellElement>
            </ShellElement>
            <ShellElement as="section" shellRole="browser-section">
              <h2>
                <Icon glyph={IconClock} role="label" />
                Recently used
              </h2>
              {recentRows.map((entry) => (
                <ShellElement as="div" shellRole="browser-recent" key={entry.url}>
                  <ShellElement as="button" shellRole="browser-recent-open" onClick={() => navigate(entry.url)}>
                    {entry.favicon ? (
                      <img src={entry.favicon} alt="" />
                    ) : (
                      <ShellElement as="span" shellRole="browser-recent-favicon">{entry.title.slice(0, 1).toUpperCase()}</ShellElement>
                    )}
                    <span>
                      <strong>{entry.title}</strong>
                      <small>{entry.url.replace(/^https?:\/\//i, '')}</small>
                    </span>
                  </ShellElement>
                  <ShellElement
                    as="button"
                    shellRole="browser-remove"
                    aria-label={`Remove ${entry.url} from recent`}
                    onClick={() => {
                      const next = recents.filter((row) => row.url !== entry.url)
                      setRecents(next)
                      localStorage.setItem(localRecentKey(workspace), JSON.stringify(next))
                    }}
                  >
                    <Icon glyph={IconClose} role="label" />
                  </ShellElement>
                </ShellElement>
              ))}
            </ShellElement>
            {failMsg && (
              <ShellElement as="p" shellRole="browser-error" role="status">
                {failMsg}
              </ShellElement>
            )}
          </ShellElement>
        </ShellElement>
      )}
    </ShellBrowserRoot>
  )
}

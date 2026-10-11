import { useEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { openExternal } from '../../houston/bridge'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
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
  IconPhone,
  IconTablet,
  IconTarget,
  IconExpand,
} from '../icons'
import { popupTabDecision, toNavUrl } from '../browserTabs'
import { useBrowserNav, type BrowserPageState } from '../browserNav'
import { saveBrowserTabUrl } from '../../scmPanel'
import { openSideBrowser } from '../../sidePanel'
import { useBrowserOpenUrl } from '../../houston/browserState'
import { BrowserActConfirm } from '../BrowserActConfirm'
import { useBrowserConfirm } from '../../houston/browserConfirm'
import { BrowserFullscreen } from '../BrowserFullscreen'
import { PickerStrip, usePickerController } from '../BrowserPicker'
import { browserSecurity, useBrowserDevice, type BrowserDevice } from '../browserDevices'
import { BrowserHeadButton, BrowserCaption, BrowserDeviceRow, BrowserDeviceGroup, DevicePresetButton, BrowserSecurityBadge, BrowserStage, BrowserStatusBand } from '../ui/BrowserSurface'
import { BrowserPaneStageState } from '../ui/BrowserPaneStates'
import { isTauri } from '../../houston/host'
import { nativeCommandErrorMessage } from '../../houston/browserHost'
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
  initialUrl?: string
  onNativeError?: (text: string) => void
  onSendToTerminal?: (text: string) => void
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
  initialUrl = '',
  onSendToTerminal,
  onNativeError,
  tabId,
  active: isActive,
  onTitleChange,
  client,
  onFocusPane,
}: BrowserSurfaceProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<BrowserViewportHandle>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [active, setPage] = useState<BrowserPageState>(() => ({url: initialUrl || null}))
  const [urlInput, setUrlInput] = useState(initialUrl)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>(() => readRecents(workspace))
  const patchPage = (patch: Partial<BrowserPageState>): void => setPage((page) => ({...page, ...patch}))
  const localServers = useBrowserPaneLocalServers(client, workspace, true, !isActive, false)
  const nav = useBrowserNav(tabId, active, patchPage, setUrlInput, setFailMsg, () => {})
  const [fullscreen, setFullscreen] = useState(false)
  const [details, setDetails] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [lastFailureAt, setLastFailureAt] = useState<number | null>(null)
  const [mountFailed, setMountFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [stage, setStage] = useState({width: 0, height: 0})
  const stageRef = useRef<HTMLDivElement>(null)
  const {device, setDevice, size, zoom, deviceRefusal, nativeReady, onReady} = useBrowserDevice(tabId, stage)
  const pendingAct = useBrowserConfirm()
  const confirmingHere = pendingAct?.surfaceId === tabId
  const picker = usePickerController(tabId, !isActive || !active.url || !onSendToTerminal, onSendToTerminal)
  useBrowserOpenUrl(tabId, (url) => {
    const decision = popupTabDecision(isActive, 0, url)
    if ('refused' in decision) { setFailMsg(decision.refused); return }
    openSideBrowser(`browser-${crypto.randomUUID()}`, decision.url, workspace)
  })
  useEffect(() => {
    if (active.url) saveBrowserTabUrl(workspace, tabId, active.url)
  }, [active.url, workspace, tabId])
  useEffect(() => {
    if (nav.browserState?.error) {
      setAttempts((value) => value + 1)
      setLastFailureAt(Date.now())
    }
    if (nav.browserState?.mountFailed) setMountFailed(true)
  }, [nav.browserState])
  useEffect(() => {
    if (!isActive || failMsg || mountFailed) setFullscreen(false)
    viewportRef.current?.remeasure()
  }, [isActive, fullscreen, failMsg, mountFailed])
  useEffect(() => {
    const node = stageRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setStage({width: node.clientWidth, height: node.clientHeight})
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const title = pageTitle(active)

  const titleCallback = useRef(onTitleChange)
  titleCallback.current = onTitleChange
  useEffect(() => {
    titleCallback.current(title, active.favicon ?? null)
  }, [active.favicon, title])

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
  const recentRows = useMemo(() => recents.slice(0, RECENT_LIMIT), [recents])

  const navigate = (value: string): void => {
    const url = addressUrl(value)
    nav.openUrl(url)
  }

  return (
    <ShellBrowserRoot ref={hostRef} data-active={isActive || undefined}>
      <BrowserToolbar active={active} isActive={isActive} nav={nav} pageLabel={title} urlInput={urlInput} setUrlInput={setUrlInput} addressRef={addressRef} localServers={localServers} navigate={navigate} picker={picker} tabId={tabId} onSendToTerminal={onSendToTerminal} onFullscreen={() => setFullscreen(true)} />
      <BrowserDeviceControls device={device} setDevice={setDevice} size={size} zoom={zoom} deviceRefusal={deviceRefusal} nativeReady={nativeReady} url={active.url} />
      <PickerStrip id={tabId} controller={picker} />
      <ShellElement as="div" shellRole="browser-load">{loading && <span />}</ShellElement>
      <BrowserStage ref={stageRef}>
      {active.url ? (
        <>
        {mountFailed && (
          <BrowserStatusBand data-testid="browser-pane-mount-recovery" tone="danger" edge="bottom" action={{label: 'Retry', onClick: () => {setMountFailed(false); setFailMsg(null); setRetry((value) => value + 1)}}}>{failMsg ?? 'Browser webview failed to mount. Retry to recreate it.'}</BrowserStatusBand>
        )}
        {!mountFailed && <BrowserFullscreen active={fullscreen} onExit={() => setFullscreen(false)} hostDevice={device} hostStyle={failMsg ? {display: 'none'} : size ? {width: size.width * zoom, height: size.height * zoom, flex: 'none'} : undefined} urlLabel={active.url} canGoBack={Boolean(active.canGoBack)} canGoForward={Boolean(active.canGoForward)} loading={loading} onBack={nav.goBack} onForward={nav.goForward} onReload={() => nav.reload()} onNavigate={navigate}>
          <BrowserViewport
            key={retry}
            ref={viewportRef}
            id={tabId}
            url={active.url}
            workspaceDir={workspace}
            hidden={!isActive || Boolean(failMsg)}
            fullscreen={fullscreen}
            dropzoneActive={confirmingHere}
            overlay={confirmingHere && pendingAct ? <BrowserActConfirm request={pendingAct} onDone={() => {}} /> : undefined}
            exemptFromReason={fullscreen ? 'modal' : undefined}
            onReady={onReady}
            style={!fullscreen && size ? {width: size.width, height: size.height, flex: 'none', transform: `scale(${zoom})`, transformOrigin: 'top left'} : undefined}
            onMountFailure={() => setMountFailed(true)}
            onError={(context, id, error) => {
              const text = nativeCommandErrorMessage(context, id, error)
              console.error(text)
              setFailMsg(text)
              onNativeError?.(text)
              setAttempts((value) => value + 1)
              setLastFailureAt(Date.now())
              setDetails(true)
            }}
          >
            {null}
          </BrowserViewport>
        </BrowserFullscreen>}
        <BrowserPaneStageState fresh={false} failMsg={failMsg} url={active.url} attempts={attempts} lastFailureAt={lastFailureAt} details={details} recents={[]} setRecents={() => {}} {...localServers} urlRef={addressRef} setFailMsg={setFailMsg} setDetails={setDetails} reload={() => {setFailMsg(null); setAttempts((value) => value + 1); nav.reload()}} openUrl={navigate} />
        </>
      ) : (
        <BrowserStartScreen localServers={localServers} recentRows={recentRows} onFocusPane={onFocusPane} navigate={navigate} failMsg={failMsg} onRemoveRecent={(url) => {
          const next = recents.filter((row) => row.url !== url)
          setRecents(next)
          localStorage.setItem(localRecentKey(workspace), JSON.stringify(next))
        }} />
      )}
      </BrowserStage>
    </ShellBrowserRoot>
  )
}

function BrowserDeviceControls({device, setDevice, size, zoom, deviceRefusal, nativeReady, url}: Omit<ReturnType<typeof useBrowserDevice>, 'onReady'> & {url: string | null}): React.JSX.Element {
  return (<BrowserDeviceRow><BrowserDeviceGroup>{(['desktop', 'phone', 'tablet'] as BrowserDevice[]).map((value) => <Tooltip key={value} label={value !== 'desktop' && deviceRefusal ? deviceRefusal : value}><DevicePresetButton aria-label={value === 'phone' ? 'Phone 393 × 852' : value === 'tablet' ? 'Tablet 820 × 1180' : 'Desktop'} aria-pressed={device === value} disabled={value !== 'desktop' && (deviceRefusal != null || (isTauri() && !nativeReady))} onClick={() => setDevice(value)}><Icon glyph={value === 'phone' ? IconPhone : value === 'tablet' ? IconTablet : IconMonitor} role="label" /></DevicePresetButton></Tooltip>)}</BrowserDeviceGroup><BrowserCaption>{size ? `${size.width} × ${size.height} · ${Math.round(zoom * 100)}%` : 'fit · 100%'}</BrowserCaption>{url && <BrowserSecurityBadge insecure={browserSecurity(url) === 'not secure'}>{browserSecurity(url)}</BrowserSecurityBadge>}</BrowserDeviceRow>)
}

function BrowserStartScreen({localServers, recentRows, onFocusPane, navigate, failMsg, onRemoveRecent}: {
  localServers: ReturnType<typeof useBrowserPaneLocalServers>
  recentRows: RecentEntry[]
  onFocusPane?: (session: number) => void
  navigate: (url: string) => void
  failMsg: string | null
  onRemoveRecent: (url: string) => void
}): React.JSX.Element {
  return (<ShellElement as="div" shellRole="browser-empty">
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
                  <Tooltip label={`Remove ${entry.url} from recent`}><ShellElement
                    as="button"
                    shellRole="browser-remove"
                    aria-label={`Remove ${entry.url} from recent`}
                    onClick={() => onRemoveRecent(entry.url)}
                  >
                    <Icon glyph={IconClose} role="label" />
                  </ShellElement></Tooltip>
                </ShellElement>
              ))}
            </ShellElement>
            {failMsg && (
              <ShellElement as="p" shellRole="browser-error" role="status">
                {failMsg}
              </ShellElement>
            )}
          </ShellElement>
        </ShellElement>)
}

function BrowserToolbar({active, isActive, nav, pageLabel, urlInput, setUrlInput, addressRef, localServers, navigate, picker, tabId, onSendToTerminal, onFullscreen}: {
  active: BrowserPageState
  isActive: boolean
  nav: ReturnType<typeof useBrowserNav>
  pageLabel: string
  urlInput: string
  setUrlInput: (value: string) => void
  addressRef: React.RefObject<HTMLInputElement | null>
  localServers: ReturnType<typeof useBrowserPaneLocalServers>
  navigate: (url: string) => void
  picker: ReturnType<typeof usePickerController>
  tabId: string
  onSendToTerminal?: (text: string) => void
  onFullscreen: () => void
}): React.JSX.Element {
  const [addressFocused, setAddressFocused] = useState(false)
  const [serversMenu, setServersMenu] = useState(false)
  const favicon = active.favicon
  return (<ShellElement as="div" shellRole="browser-toolbar">
        <Tooltip label="Back"><BrowserHeadButton aria-label="Back" disabled={!isActive || !active.canGoBack} onClick={nav.goBack}>
          <Icon glyph={IconChevronLeft} role="ui" />
        </BrowserHeadButton></Tooltip>
        <Tooltip label="Forward"><BrowserHeadButton aria-label="Forward" disabled={!isActive || !active.canGoForward} onClick={nav.goForward}>
          <Icon glyph={IconChevronRight} role="ui" />
        </BrowserHeadButton></Tooltip>
        <Tooltip label="Reload — Shift+Click bypasses the cache"><BrowserHeadButton aria-label="Reload" disabled={!isActive || !active.url} onClick={(event) => nav.reload(event.shiftKey)}>
          <Icon glyph={IconRefresh} role="ui" />
        </BrowserHeadButton></Tooltip>
        <ShellElement as="label" shellRole="browser-address">
          {favicon ? (
            <img src={favicon} alt="" />
          ) : active.url ? (
            <ShellElement as="span" shellRole="browser-favicon">{pageLabel.slice(0, 1).toUpperCase()}</ShellElement>
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
          <Tooltip label="Local servers">
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
          </Tooltip>
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
        <Tooltip label="Open in system browser"><BrowserHeadButton
          aria-label="Open in system browser"
          disabled={!isActive || !active.url}
          onClick={() =>
            active.url &&
            void openExternal(active.url).catch((error: unknown) => console.warn('houston: openExternal failed', error))
          }
        >
          <Icon glyph={IconExternal} role="ui" />
        </BrowserHeadButton></Tooltip>
        <Tooltip label={!onSendToTerminal ? 'Select element — focus a live agent pane first' : 'Select element'}><BrowserHeadButton aria-label="Select element" data-testid={`browser-picker-toggle-${tabId}`} disabled={!isActive || !active.url || !onSendToTerminal} aria-pressed={picker.enabled} onClick={picker.toggle}><Icon glyph={IconTarget} role="ui" /></BrowserHeadButton></Tooltip>
        <Tooltip label="Full screen"><BrowserHeadButton aria-label="Full screen" disabled={!isActive || !active.url} onClick={() => onFullscreen()}><Icon glyph={IconExpand} role="ui" /></BrowserHeadButton></Tooltip>
      </ShellElement>)
}

function pageTitle(page: BrowserPageState): string {
  return page.title?.trim() || (page.url ? page.url.replace(/^https?:\/\//, '').split('/')[0] : 'New tab')
}

import { useContext, useEffect, useRef, useState } from 'react'
import { GLOW_DANGER, GLOW_WARNING, RING_ACCENT_ICON } from './shadowChrome'
import type { BrowserNode } from '../layout/tree'
import { openSideBrowser } from '../sidePanel'
import { openExternal } from '../houston/bridge'
import { isTauri } from '../houston/host'
import { nativeCommandErrorMessage } from '../houston/browserHost'
import { BrowserFullscreen } from './BrowserFullscreen'
import { PickerStrip, usePickerController } from './BrowserPicker'
import { BrowserViewport, type BrowserViewportHandle } from './BrowserViewport'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCollapse,
  IconExpand,
  IconExternal,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTarget,
  IconMonitor,
  IconPhone,
  IconTablet
} from './icons'
import { URL_INPUT_CLS, WEBVIEW_HOST_CLS } from './panelChrome'

const SURFACE_RADIUS_CLS =
  'rounded-b-[calc(var(--tr-radius-md)-1px)] [@container_(max-width:280px)]:rounded-b-[calc(var(--tr-radius-sm)-1px)]'
import { PANE_BORDER_CLS, PANE_HEAD_BG_CLS, usePaneFocusTier } from '../windowFocus'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { Tooltip } from './Tooltip'
import { BrowserActConfirm } from './BrowserActConfirm'
import { useBrowserConfirm } from '../houston/browserConfirm'
import { useBrowserPaneLoad } from '../houston/browserOpenRequest'
import {
  type BrowserTab,
  TabWebview,
  TabsPopover,
  clearRecents,
  loadRecents,
  loadTabs,
  toNavUrl,
  useBrowserTabs
} from './browserTabs'
import { useBrowserNav } from './browserNav'
import { tabsStorageKey } from './browserTabsKey'
import { Icon } from './Icon'
import { browserSecurity, useBrowserDevice, type BrowserDevice } from './browserDevices'
import type { HoustonClient } from '../houston/client'
import { BrowserBlankState, BrowserUnreachableState } from './ui/BrowserPaneStates'
import { unreachableHost, unreachableMessage } from './ui/browserUnreachable'
import { GridHiddenContext } from '../layout/gridHiddenContext'

interface Props {
  node: BrowserNode
  workspaceDir: string
  onNavigate: (url: string) => void
  onClose: () => void
  onHeaderPointerDown: (e: React.PointerEvent) => void
  active?: boolean
  hiddenByExpand?: boolean
  dropzoneActive?: boolean
  onSendToTerminal?: (text: string) => void
  onNativeError?: (text: string) => void
  loadRequest?: { url: string }
  panel?: boolean
  onMoveToGrid?: (url: string) => void
  focusUrlRequest?: number
  client?: HoustonClient
}

const ICO_HEAD_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none [@container_(max-width:280px)]:w-5 [@container_(max-width:280px)]:h-5 [@container_(max-width:200px)]:w-[18px] [@container_(max-width:200px)]:h-[18px] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))]`
const ICO_HEAD_REGULAR =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]'
const ICO_HEAD_DANGER =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
const ICO_HEAD_INFO =
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'

const NAV_BTN_CLS =
  `inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] text-[var(--text-muted)] bg-transparent border-0 flex-none [transition:color_0.14s_ease,background_0.14s_ease,transform_0.14s_ease] enabled:hover:text-[var(--text-primary)] enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] enabled:active:scale-[0.92] disabled:opacity-[0.28] disabled:cursor-default`

function seedTabs(key: string, fallbackUrl: string): { tabs: BrowserTab[]; activeTabId: number } {
  const restored = loadTabs(key)
  if (restored.tabs.length === 1 && restored.tabs[0].url === null) {
    if (fallbackUrl === '') return restored
    return { tabs: [{ id: 1, url: fallbackUrl }], activeTabId: 1 }
  }
  return restored
}

export function BrowserPane({
  node,
  workspaceDir,
  onNavigate,
  onClose,
  onHeaderPointerDown,
  active: paneActive = false,
  onNativeError,
  hiddenByExpand,
  dropzoneActive,
  onSendToTerminal,
  loadRequest,
  panel = false,
  onMoveToGrid,
  focusUrlRequest = 0,
  client
}: Props): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = stageRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setStage({ width: Math.max(0, element.clientWidth - 32), height: Math.max(0, element.clientHeight - 60) })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const { device, setDevice, size, zoom, deviceRefusal, nativeReady, onReady } = useBrowserDevice(node.id, stage)
  const tabsKey = tabsStorageKey(node.id)
  const [restored] = useState(() => {
    const saved = seedTabs(tabsKey, node.url)
    if (!loadRequest?.url.trim()) return saved
    return { ...saved, tabs: saved.tabs.map((tab) => tab.id === saved.activeTabId ? { ...tab, url: toNavUrl(loadRequest.url) } : tab) }
  })
  const [urlInput, setUrlInput] = useState(
    () => restored.tabs.find((t) => t.id === restored.activeTabId)?.url ?? ''
  )
  const [urlFocused, setUrlFocused] = useState(false)
  const [popover, setPopover] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [failureAttempts, setFailureAttempts] = useState(0)
  const [showFailureDetails, setShowFailureDetails] = useState(false)
  const [localServerReply, setLocalServerReply] = useState<{
    workspace: string
    servers: import('../houston/generated/LocalServer').LocalServer[]
    unsupported: string | null
    truncated: boolean
  } | null>(null)
  const gridHidden = useContext(GridHiddenContext)
  const [recents, setRecents] = useState<string[]>(loadRecents)
  const hostRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const focusTier = usePaneFocusTier(paneActive)

  const seenFocusReq = useRef(focusUrlRequest)
  useEffect(() => {
    if (focusUrlRequest === seenFocusReq.current) return
    seenFocusReq.current = focusUrlRequest
    if (!paneActive) return
    urlRef.current?.focus()
  }, [focusUrlRequest, paneActive])
  const [fullscreen, setFullscreen] = useState(false)
  const [detached, setDetached] = useState(false)
  const [detachError, setDetachError] = useState<string | null>(null)
  const viewportRef = useRef<BrowserViewportHandle>(null)
  const pendingAct = useBrowserConfirm()
  const confirmingHere = pendingAct != null && pendingAct.surfaceId === node.id
  useEffect(() => {
    viewportRef.current?.remeasure()
  }, [fullscreen])

  const { tabs, active, persistError, patchTab, selectTab, newTab, closeTab } = useBrowserTabs(
    node.id,
    tabsKey,
    restored,
    { hiddenByExpand, onNativeError, setUrlInput, setFailMsg }
  )

  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  useEffect(() => {
    if (active.url) onNavigateRef.current(active.url)
    if (active.url) {
      setFailMsg(null)
      setFailureAttempts(0)
      setShowFailureDetails(false)
    }
  }, [active.url])

  const { browserState, goBack, goForward, reload, openUrl } = useBrowserNav(
    node.id,
    hostRef,
    tabs,
    active,
    patchTab,
    setUrlInput,
    setFailMsg,
    setRecents
  )
  useBrowserPaneLoad(node.id, openUrl)
  useEffect(() => {
    if (loadRequest?.url.trim() && loadRequest.url !== active.url) openUrl(loadRequest.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRequest])

  const [surfaceMountFailed, setSurfaceMountFailed] = useState(false)
  useEffect(() => {
    if (browserState?.mountFailed) setSurfaceMountFailed(true)
  }, [browserState])
  const retryMount = (): void => setSurfaceMountFailed(false)

  useEffect(() => {
    if (fullscreen && (surfaceMountFailed || !tabs.some((t) => t.url !== null))) {
      setFullscreen(false)
    }
  }, [fullscreen, surfaceMountFailed, tabs])

  const fresh = active.url === null

  useEffect(() => {
    if (!client || !fresh || hiddenByExpand || gridHidden) return
    const unsubscribe = client.subscribe('workspace_local_servers', (message) => {
      if (message.workspace !== workspaceDir) return
      setLocalServerReply({ workspace: message.workspace, servers: message.servers, unsupported: message.unsupported, truncated: message.truncated })
    })
    const refresh = (): void => client.workspaceLocalServers(workspaceDir)
    refresh()
    // Three seconds keeps the list responsive while limiting repeated /proc scans.
    const interval = window.setInterval(refresh, 3000)
    return () => {
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [client, fresh, gridHidden, hiddenByExpand, workspaceDir])

  useEffect(() => {
    if (hiddenByExpand) { setPopover(false); setFullscreen(false) }
  }, [hiddenByExpand])
  const picker = usePickerController(node.id, fresh || !onSendToTerminal || !!hiddenByExpand, onSendToTerminal)

  return (
    <section
      ref={hostRef}
      className={`pane browser flex-1 min-w-0 min-h-0 relative flex flex-col border ${PANE_BORDER_CLS[focusTier]} bg-[var(--tool-code-bg)] overflow-hidden rounded-[var(--tr-radius-md)] [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] [transition:border-color_0.15s_ease] ${paneActive ? 'focus' : ''}`}
      data-panekey={node.id}
    >
      <header
        className={`group pane-head touch-none flex items-center gap-2 pr-1 pl-[10px] h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] ${PANE_HEAD_BG_CLS[focusTier]} border-b border-b-[color-mix(in_srgb,var(--border)_55%,transparent)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tracking-[-0.005em] text-[var(--text-primary)] flex-none cursor-grab active:cursor-grabbing [.pane-slot.drag-src_&]:cursor-grabbing [transition:background_0.2s,border-color_0.2s] @container`}
        onPointerDown={onHeaderPointerDown}
      >
        <span className="agent-dot w-[7px] h-[7px] rounded-full flex-none bg-[var(--border-hover)]" />
        <Tooltip label="Back">
          <button className={NAV_BTN_CLS} aria-label="Back" disabled={!active.canGoBack} onClick={goBack}>
            <Icon glyph={IconChevronLeft} role="ui" />
          </button>
        </Tooltip>
        <Tooltip label="Forward">
          <button
            className={NAV_BTN_CLS}
            aria-label="Forward"
            disabled={!active.canGoForward}
            onClick={goForward}
          >
            <Icon glyph={IconChevronRight} role="ui" />
          </button>
        </Tooltip>
        <Tooltip label="Reload — Shift+Click bypasses the cache">
          <button
            className={NAV_BTN_CLS}
            aria-label="Reload"
            disabled={fresh}
            onClick={(e) => reload(e.shiftKey)}
          >
            <span className={active.loading ? 'loop-anim inline-flex animate-[spin_1s_linear_infinite]' : 'inline-flex'}>
              <Icon glyph={IconRefresh} role="ui" />
            </span>
          </button>
        </Tooltip>
        <div className="browser-url relative flex-1 min-w-0 flex items-center">
          <span
            className={`absolute left-1.5 top-1/2 -translate-y-1/2 inline-flex pointer-events-none [transition:color_0.16s_ease] ${urlFocused ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}
            aria-hidden
            hidden={!fresh}
          >
            <Icon glyph={IconSearch} role="label" />
          </span>
          {!fresh && <span className={`browser-security ${browserSecurity(active.url) === 'not secure' ? 'insecure' : ''}`}>{browserSecurity(active.url)}</span>}
          <input
            ref={urlRef}
            aria-label="Address and search bar"
            className={`${URL_INPUT_CLS} ${fresh ? 'pl-[22px]' : 'browser-address'}`}
            placeholder={fresh ? 'enter a url to open a new tab' : 'search or enter url'}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={(e) => {
              setUrlFocused(true)
              e.currentTarget.select()
            }}
            onBlur={() => setUrlFocused(false)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && urlInput.trim()) openUrl(urlInput)
              else if (e.key === 'Escape') urlRef.current?.blur()
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <BrowserHeadActions node={node} tabs={tabs} active={active} popover={popover} setPopover={setPopover} selectTab={selectTab} closeTab={closeTab} newTab={newTab} urlInput={urlInput} fullscreen={fullscreen} setFullscreen={setFullscreen} detached={detached} viewportRef={viewportRef} setDetachError={setDetachError} picker={picker} panel={panel} workspaceDir={workspaceDir} onSendToTerminal={onSendToTerminal} onMoveToGrid={onMoveToGrid} onClose={onClose} />
      </header>
      <div className="relative h-0.5 w-full overflow-hidden flex-none z-[var(--z-base)]" aria-hidden>
        {active.loading &&
          (active.progress != null ? (
            <div
              className="absolute inset-y-0 left-0 w-full origin-left opacity-80 bg-[var(--text-primary)] [transition:transform_0.12s_ease]"
              style={{ transform: `scaleX(${Math.min(1, Math.max(0, active.progress))})` }}
            />
          ) : (
            <div className="loop-anim absolute inset-0 opacity-60 motion-safe:w-2/5 motion-safe:bg-[linear-gradient(to_right,transparent,var(--text-primary)_50%,transparent)] motion-safe:[animation:rbrowser-progress-slide_1.15s_cubic-bezier(0.4,0,0.3,1)_infinite] motion-reduce:w-full motion-reduce:bg-[var(--text-primary)]" />
          ))}
      </div>
      {persistError && (
        <div
          className="flex items-center gap-2 py-[6px] pr-3 pl-4 flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[color-mix(in_srgb,var(--warning)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border-b border-[color-mix(in_srgb,var(--warning)_28%,transparent)] z-[var(--z-base)]"
          role="alert"
          data-testid="browser-pane-persist-error"
        >
          <span
            className={`flex-none w-1.5 h-1.5 rounded-[999px] bg-warning shadow-[${GLOW_WARNING}]`}
            aria-hidden
          />
          <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{persistError}</span>
        </div>
      )}
      {detachError && (
        <div
          className="flex items-center gap-2 py-[6px] pr-3 pl-4 flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border-b border-[color-mix(in_srgb,var(--danger)_28%,transparent)] z-[var(--z-base)]"
          role="alert"
          data-testid={`browser-detach-error-${node.id}`}
        >
          <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{detachError}</span>
          <button
            type="button"
            className="btn flex-none py-0.5 px-[7px] border-0 rounded-[var(--tr-radius-input)] bg-transparent text-inherit font-semibold [transition:background_0.12s_ease] hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]"
            onClick={() => setDetachError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {surfaceMountFailed && (
        <div
          className="flex items-center gap-2 py-[6px] pr-3 pl-4 flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border-b border-[color-mix(in_srgb,var(--danger)_28%,transparent)] z-[var(--z-base)]"
          role="alert"
          data-testid="browser-pane-mount-recovery"
        >
          <span className={`flex-none w-1.5 h-1.5 rounded-[999px] bg-danger shadow-[${GLOW_DANGER}]`} aria-hidden />
          <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            Browser webview failed to mount. Retry to recreate it.
          </span>
          <button
            type="button"
            className="btn flex-none py-0.5 px-[7px] border-0 rounded-[var(--tr-radius-input)] bg-transparent text-inherit font-semibold [transition:background_0.12s_ease] hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]"
            onClick={retryMount}
          >
            Retry
          </button>
        </div>
      )}
      <div className="browser-devrow">
        <DevicePresetButtons device={device} onDevice={setDevice} refusal={deviceRefusal} ready={nativeReady} />
        <span className="browser-caption">{size ? `${size.width} × ${size.height} · ${Math.round(zoom * 100)}%` : 'fit · 100%'}</span>
      </div>
      <PickerStrip id={node.id} controller={picker} />
      <div ref={stageRef} className="browser-stage">
      {tabs.some((t) => t.url !== null) && !surfaceMountFailed && failMsg === null && (
        <BrowserFullscreen
          active={fullscreen}
          onExit={() => setFullscreen(false)}
          hostClassName={`browser-device ${device}`}
          hostStyle={size ? { width: size.width * zoom, height: size.height * zoom, flex: 'none' } : undefined}
          urlLabel={active.url ?? ''}
          canGoBack={Boolean(active.canGoBack)}
          canGoForward={Boolean(active.canGoForward)}
          loading={Boolean(active.loading)}
          onBack={goBack}
          onForward={goForward}
          onReload={() => reload(false)}
          onNavigate={openUrl}
        >
          <BrowserViewport
            onReady={onReady}
            id={node.id}
            workspaceDir={workspaceDir}
            url={(active.url ?? tabs.find((t) => t.url !== null)?.url) as string}
            className={fullscreen ? WEBVIEW_HOST_CLS : `${WEBVIEW_HOST_CLS} ${SURFACE_RADIUS_CLS}`}
            style={!fullscreen && size ? { width: size.width, height: size.height, flex: 'none', transform: `scale(${zoom})`, transformOrigin: 'top left' } : undefined}
            hidden={hiddenByExpand}
            dropzoneActive={dropzoneActive || confirmingHere}

            overlay={
              confirmingHere && pendingAct ? (
                <BrowserActConfirm
                  request={pendingAct}
                  onDone={() => {
                  }}
                />
              ) : undefined
            }
            noActiveTab={active.url === null}
            exemptFromReason={fullscreen ? 'modal' : undefined}
            onMountFailure={() => setSurfaceMountFailed(true)}
            onError={(context, surfaceId, err) => {
              const text = nativeCommandErrorMessage(context, surfaceId, err)
              console.error(text)
              setFailMsg(text)
              setFailureAttempts((count) => count + 1)
              onNativeError?.(text)
            }}
            onDetachedChange={setDetached}
            ref={viewportRef}
          >
            {tabs
              .filter((t) => t.url !== null)
              .map((t) => (
                <TabWebview
                  key={t.id}
                  url={t.url as string}
                  visible={t.id === active.id}
                  onNavigate={(navUrl, canGoBack, canGoForward) => {
                    patchTab(t.id, { url: navUrl, canGoBack, canGoForward })
                    if (t.id === active.id) setUrlInput(navUrl)
                  }}
                  onMeta={(meta) => patchTab(t.id, meta)}
                  onLoading={(loading) => patchTab(t.id, { loading })}
                  onFail={(desc) => {
                    if (t.id === active.id) {
                      setFailMsg(desc)
                      setFailureAttempts((count) => count + 1)
                    }
                  }}
                />
              ))}
          </BrowserViewport>
        </BrowserFullscreen>
      )}
      {!fresh && failMsg === null && <span className="browser-caption">Select element · click to hand it to the focused agent</span>}
      {fresh && (
        <BrowserBlankState
          recents={recents.map((url) => ({ url, onOpen: () => openUrl(url) }))}
          servers={localServerReply?.workspace === workspaceDir ? localServerReply.servers : []}
          unsupported={localServerReply?.workspace === workspaceDir ? localServerReply.unsupported : null}
          truncated={localServerReply?.workspace === workspaceDir && localServerReply.truncated}
          onClear={() => { clearRecents(); setRecents([]) }}
          onOpenPage={() => urlRef.current?.focus()}
          onOpenServer={openUrl}
        />
      )}
      {!fresh && failMsg !== null && (
        <BrowserUnreachableState
          host={unreachableHost(active.url ?? '')}
          message={unreachableMessage(active.url ?? '', failMsg)}
          rawError={failMsg}
          url={active.url ?? ''}
          attempts={failureAttempts}
          details={showFailureDetails}
          onRetry={() => { setFailMsg(null); setShowFailureDetails(false); reload(false) }}
          onToggleDetails={() => setShowFailureDetails((visible) => !visible)}
        />
      )}
      </div>
    </section>
  )
}


function DevicePresetButtons({ device, onDevice, refusal, ready }: { device: BrowserDevice; onDevice: (device: BrowserDevice) => void; refusal: string | null; ready: boolean }): React.JSX.Element {
  return <div className="browser-device-buttons" role="group" aria-label="Device preset">{([['desktop', 'Desktop', IconMonitor], ['phone', 'Phone 393 × 852', IconPhone], ['tablet', 'Tablet 820 × 1180', IconTablet]] as const).map(([value, label, glyph]) => <Tooltip key={value} label={refusal && value !== 'desktop' ? `${label} unavailable: ${refusal}` : label}><button className={NAV_BTN_CLS} aria-label={label} aria-pressed={device === value} disabled={value !== 'desktop' && (refusal != null || (isTauri() && !ready))} onClick={() => onDevice(value)}><Icon glyph={glyph} role="label" /></button></Tooltip>)}</div>
}

function BrowserHeadActions({ node, tabs, active, popover, setPopover, selectTab, closeTab, newTab, urlInput, fullscreen, setFullscreen, detached, viewportRef, setDetachError, picker, panel, workspaceDir, onSendToTerminal, onMoveToGrid, onClose }: {
  node: BrowserNode
  tabs: ReturnType<typeof useBrowserTabs>['tabs']
  active: ReturnType<typeof useBrowserTabs>['active']
  popover: boolean
  setPopover: React.Dispatch<React.SetStateAction<boolean>>
  selectTab: ReturnType<typeof useBrowserTabs>['selectTab']
  closeTab: ReturnType<typeof useBrowserTabs>['closeTab']
  newTab: ReturnType<typeof useBrowserTabs>['newTab']
  urlInput: string
  fullscreen: boolean
  setFullscreen: React.Dispatch<React.SetStateAction<boolean>>
  detached: boolean
  viewportRef: React.RefObject<BrowserViewportHandle | null>
  setDetachError: React.Dispatch<React.SetStateAction<string | null>>
  picker: ReturnType<typeof usePickerController>
  panel: boolean
  workspaceDir: string
  onSendToTerminal?: (text: string) => void
  onMoveToGrid?: (url: string) => void
  onClose: () => void
}): React.JSX.Element {
  const fresh = active.url === null
  return (
        <span className="head-actions flex items-center gap-px flex-none">
          <div className="relative flex-shrink-0">
            <Tooltip label={`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`}>
              <button
                type="button"
                className="btn inline-flex items-center gap-[3px] h-[var(--h-ctl-mini)] py-0 px-[7px] rounded-[var(--tr-radius-sm)] bg-transparent border-0 text-[var(--text-muted)] font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [transition:color_0.14s_ease,background_0.14s_ease] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] data-[open]:text-[var(--text-primary)] data-[open]:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)]"
                data-open={popover || undefined}
                aria-haspopup="menu"
                aria-expanded={popover}
                aria-label={`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`}
                onClick={() => setPopover((cur) => !cur)}
              >
                <span className="min-w-[9px] text-center tracking-[0.01em] tabular-nums">{tabs.length}</span>
                <Icon glyph={IconChevronDown} role="label" />
              </button>
            </Tooltip>
            {popover && (
              <TabsPopover
                tabs={tabs}
                activeId={active.id}
                onSelect={selectTab}
                onCloseTab={closeTab}
                onNewTab={newTab}
                onDismiss={() => setPopover(false)}
              />
            )}
          </div>
          <Tooltip label="Open in external browser">
            <button
              className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_REGULAR}`}
              aria-label="Open in external browser"
              disabled={fresh}
              onClick={() =>
                void openExternal(toNavUrl(urlInput)).catch((err: unknown) => {
                  console.warn('houston: openExternal failed', err)
                })
              }
            >
              <Icon glyph={IconExternal} role="ui" />
            </button>
          </Tooltip>
          <Tooltip label={fullscreen ? 'Exit full screen (Esc)' : 'Expand to full screen'}>
            <button
              className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${fullscreen ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
              aria-label={fullscreen ? 'Exit full screen' : 'Expand browser to full screen'}
              aria-pressed={fullscreen}
              disabled={fresh}
              onClick={() => setFullscreen((cur) => !cur)}
            >
              {fullscreen ? <Icon glyph={IconCollapse} role="ui" /> : <Icon glyph={IconExpand} role="ui" />}
            </button>
          </Tooltip>
          <BrowserNativeActions nodeId={node.id} fresh={fresh} detached={detached} viewportRef={viewportRef} setDetachError={setDetachError} picker={picker} onSendToTerminal={onSendToTerminal} />
          <Tooltip label={panel ? 'Move to grid' : 'Move to side panel'}><button className={`${NAV_BTN_CLS}`} aria-label={panel ? 'Move to grid' : 'Move to side panel'} onClick={() => { if (panel) onMoveToGrid?.(active.url ?? ''); else { openSideBrowser(node.id, active.url ?? '', workspaceDir); onClose() } }}><Icon glyph={IconExternal} role="ui" /></button></Tooltip>
          <Tooltip label="Close">
            <button
              className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_DANGER}`}
              aria-label="Close"
              onClick={onClose}
            >
              <Icon glyph={IconClose} role="ui" />
            </button>
          </Tooltip>
        </span>
  )
}

function BrowserNativeActions({ nodeId, fresh, detached, viewportRef, setDetachError, picker, onSendToTerminal }: {
  nodeId: string
  fresh: boolean
  detached: boolean
  viewportRef: React.RefObject<BrowserViewportHandle | null>
  setDetachError: React.Dispatch<React.SetStateAction<string | null>>
  picker: ReturnType<typeof usePickerController>
  onSendToTerminal?: (text: string) => void
}): React.JSX.Element {
  return <>
          {isTauri() && (
            <Tooltip label={detached ? 'Reattach into the grid' : 'Detach into its own window'}>
              <button
                className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${detached ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
                aria-label={detached ? 'Reattach browser into the grid' : 'Detach browser into its own window'}
                aria-pressed={detached}
                disabled={fresh}
                data-testid={`browser-detach-${nodeId}`}
                onClick={() => {
                  setDetachError(null)
                  const handle = viewportRef.current
                  if (!handle) return
                  const op = detached ? handle.reattach() : handle.detach()
                  void op.catch((err: unknown) => {
                    setDetachError(
                      `${detached ? 'Reattaching' : 'Detaching'} ${JSON.stringify(nodeId)} failed: ` +
                        `${err instanceof Error ? err.message : String(err)}`
                    )
                  })
                }}
              >
                <Icon glyph={IconExternal} role="ui" />
              </button>
            </Tooltip>
          )}
          {isTauri() && (
            <Tooltip
              label={!onSendToTerminal ? 'Select element unavailable: focus a live agent pane first' : picker.enabled ? 'Stop selecting elements (Esc)' : 'Select element · click to hand it to the focused agent'}
            >
              <button
                className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${picker.enabled ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
                aria-label={picker.enabled ? 'Stop selecting elements' : 'Select a page element'}
                aria-pressed={picker.enabled}
                disabled={fresh || !onSendToTerminal}
                data-testid={`browser-picker-toggle-${nodeId}`}
                onClick={picker.toggle}
              >
                <Icon glyph={IconTarget} role="ui" />
              </button>
            </Tooltip>
          )}
  </>
}

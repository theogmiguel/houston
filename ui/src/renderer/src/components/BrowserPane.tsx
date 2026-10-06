import { useContext, useEffect, useRef, useState } from 'react'
import type { BrowserNode } from '../layout/tree'
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
  IconSearch,
  IconTarget,
  IconMonitor,
  IconPhone,
  IconTablet
} from './icons'
import { usePaneFocusTier } from '../windowFocus'
import {
  DevicePresetButton,
  PaneHeadActions,
  BrowserNavigationButton,
  TabCountButton,
  TabCount,
  UrlField,
  BrowserCaption,
  BrowserDeviceGroup,
  BrowserDeviceRow,
  AgentIndicator,
  BrowserHeadButton,
  BrowserLoadBar,
  BrowserReloadGlyph,
  BrowserSecurityBadge,
  BrowserStage,
  BrowserStatusBand,
  BrowserUrlInput,
  BrowserUrlSearchIcon
} from './ui/BrowserSurface'
import { Tooltip } from './ui/Tooltip'
import { PaneFrame, PaneHeader } from './ui'
import { BrowserActConfirm } from './BrowserActConfirm'
import { useBrowserConfirm } from '../houston/browserConfirm'
import { useBrowserPaneLoad } from '../houston/browserOpenRequest'
import {
  type BrowserTab,
  TabWebview,
  TabsPopover,
  loadRecents,
  loadTabs,
  toNavUrl,
  useBrowserTabs
} from './browserTabs'
import { useBrowserNav } from './browserNav'
import { tabsStorageKey } from './browserTabsKey'
import { Icon } from './ui/Icon'
import { browserSecurity, useBrowserDevice, type BrowserDevice } from './browserDevices'
import type { HoustonClient } from '../houston/client'
import { BrowserPaneStageState } from './ui/BrowserPaneStates'
import { hasBrowserPage, tabFailureHandler, useBrowserPaneLocalServers } from './browserPaneLocalServers'
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
  const [lastFailureAt, setLastFailureAt] = useState<number | null>(null)
  const [showFailureDetails, setShowFailureDetails] = useState(false)
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

  const recordFailureAttempt: React.Dispatch<React.SetStateAction<number>> = (update) => {
    setLastFailureAt(Date.now())
    setFailureAttempts(update)
  }

  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  useEffect(() => {
    if (active.url) onNavigateRef.current(active.url)
    if (active.url) {
      setFailMsg(null)
      setFailureAttempts(0)
      setLastFailureAt(null)
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
  const localServers = useBrowserPaneLocalServers(client, workspaceDir, fresh, hiddenByExpand, gridHidden)

  useEffect(() => {
    if (hiddenByExpand) { setPopover(false); setFullscreen(false) }
  }, [hiddenByExpand])
  const picker = usePickerController(node.id, fresh || !onSendToTerminal || !!hiddenByExpand, onSendToTerminal)

  return (
    <PaneFrame kind="browser" ref={hostRef} focusTier={focusTier} active={paneActive} data-panekey={node.id}>
      <PaneHeader
        data-pane-focus-head={focusTier}
        divider="borderMuted"
        transition="browser"
        dragCursor
        onPointerDown={onHeaderPointerDown}
      >
        <AgentIndicator />
        <Tooltip label="Back">
          <BrowserNavigationButton aria-label="Back" disabled={!active.canGoBack} onClick={goBack}>
            <Icon glyph={IconChevronLeft} role="ui" />
          </BrowserNavigationButton>
        </Tooltip>
        <Tooltip label="Forward">
          <BrowserNavigationButton
            aria-label="Forward"
            disabled={!active.canGoForward}
            onClick={goForward}
          >
            <Icon glyph={IconChevronRight} role="ui" />
          </BrowserNavigationButton>
        </Tooltip>
        <Tooltip label="Reload — Shift+Click bypasses the cache">
          <BrowserNavigationButton
            aria-label="Reload"
            disabled={fresh}
            onClick={(e) => reload(e.shiftKey)}
          >
            <BrowserReloadGlyph loading={Boolean(active.loading)} />
          </BrowserNavigationButton>
        </Tooltip>
        <UrlField>
          <BrowserUrlSearchIcon focused={urlFocused} hidden={!fresh}>
            <Icon glyph={IconSearch} role="label" />
          </BrowserUrlSearchIcon>
          {!fresh && <BrowserSecurityBadge insecure={browserSecurity(active.url) === 'not secure'}>{browserSecurity(active.url)}</BrowserSecurityBadge>}
          <BrowserUrlInput
            ref={urlRef}
            aria-label="Address and search bar"
            variant={fresh ? 'fresh' : 'address'}
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
        </UrlField>
        <BrowserHeadActions node={node} tabs={tabs} active={active} popover={popover} setPopover={setPopover} selectTab={selectTab} closeTab={closeTab} newTab={newTab} urlInput={urlInput} fullscreen={fullscreen} setFullscreen={setFullscreen} detached={detached} viewportRef={viewportRef} setDetachError={setDetachError} picker={picker} panel={panel} onSendToTerminal={onSendToTerminal} onMoveToGrid={onMoveToGrid} onClose={onClose} />
      </PaneHeader>
      <BrowserLoadBar loading={Boolean(active.loading)} progress={active.progress} />
      {persistError && (
        <BrowserStatusBand tone="warning" edge="bottom" indicator data-testid="browser-pane-persist-error">
          {persistError}
        </BrowserStatusBand>
      )}
      {detachError && (
        <BrowserStatusBand tone="danger" edge="bottom" data-testid={`browser-detach-error-${node.id}`} action={{ label: 'Dismiss', onClick: () => setDetachError(null) }}>
          {detachError}
        </BrowserStatusBand>
      )}
      {surfaceMountFailed && (
        <BrowserStatusBand tone="danger" edge="bottom" indicator data-testid="browser-pane-mount-recovery" action={{ label: 'Retry', onClick: retryMount }}>
          Browser webview failed to mount. Retry to recreate it.
        </BrowserStatusBand>
      )}
      <BrowserDeviceRow>
        <DevicePresetButtons device={device} onDevice={setDevice} refusal={deviceRefusal} ready={nativeReady} />
        <BrowserCaption>{size ? `${size.width} × ${size.height} · ${Math.round(zoom * 100)}%` : 'fit · 100%'}</BrowserCaption>
      </BrowserDeviceRow>
      <PickerStrip id={node.id} controller={picker} />
      <BrowserStage ref={stageRef}>
      {hasBrowserPage(tabs, surfaceMountFailed, failMsg) && (
        <BrowserFullscreen
          active={fullscreen}
          onExit={() => setFullscreen(false)}
          hostDevice={device}
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
            rounded={!fullscreen}
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
              recordFailureAttempt((count) => count + 1)
              setShowFailureDetails(true)
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
                  onFail={tabFailureHandler(t.id, active.id, setFailMsg, recordFailureAttempt, setShowFailureDetails)}
                />
              ))}
          </BrowserViewport>
        </BrowserFullscreen>
      )}
      <BrowserPaneStageState
        fresh={fresh}
        failMsg={failMsg}
        url={active.url ?? ''}
        attempts={failureAttempts}
        lastFailureAt={lastFailureAt}
        details={showFailureDetails}
        recents={recents}
        setRecents={setRecents}
        {...localServers}
        urlRef={urlRef}
        setFailMsg={setFailMsg}
        setDetails={setShowFailureDetails}
        reload={() => reload(false)}
        openUrl={openUrl}
      />
      </BrowserStage>
    </PaneFrame>
  )
}


function DevicePresetButtons({ device, onDevice, refusal, ready }: { device: BrowserDevice; onDevice: (device: BrowserDevice) => void; refusal: string | null; ready: boolean }): React.JSX.Element {
  return <BrowserDeviceGroup>{([['desktop', 'Desktop', IconMonitor], ['phone', 'Phone 393 × 852', IconPhone], ['tablet', 'Tablet 820 × 1180', IconTablet]] as const).map(([value, label, glyph]) => <Tooltip key={value} label={refusal && value !== 'desktop' ? `${label} unavailable: ${refusal}` : label}><DevicePresetButton aria-label={label} aria-pressed={device === value} disabled={value !== 'desktop' && (refusal != null || (isTauri() && !ready))} onClick={() => onDevice(value)}><Icon glyph={glyph} role="label" /></DevicePresetButton></Tooltip>)}</BrowserDeviceGroup>
}

function BrowserHeadActions({ node, tabs, active, popover, setPopover, selectTab, closeTab, newTab, urlInput, fullscreen, setFullscreen, detached, viewportRef, setDetachError, picker, panel, onSendToTerminal, onMoveToGrid, onClose }: {
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
  onSendToTerminal?: (text: string) => void
  onMoveToGrid?: (url: string) => void
  onClose: () => void
}): React.JSX.Element {
  const fresh = active.url === null
  return (
        <PaneHeadActions>
          <div className="relative shrink-0">
            <Tooltip label={`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`}>
              <TabCountButton
                type="button"
                data-open={popover || undefined}
                aria-haspopup="menu"
                aria-expanded={popover}
                aria-label={`${tabs.length} tab${tabs.length === 1 ? '' : 's'}`}
                onClick={() => setPopover((cur) => !cur)}
              >
                <TabCount>{tabs.length}</TabCount>
                <Icon glyph={IconChevronDown} role="label" />
              </TabCountButton>
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
            <BrowserHeadButton
              aria-label="Open in external browser"
              disabled={fresh}
              onClick={() =>
                void openExternal(toNavUrl(urlInput)).catch((err: unknown) => {
                  console.warn('houston: openExternal failed', err)
                })
              }
            >
              <Icon glyph={IconExternal} role="ui" />
            </BrowserHeadButton>
          </Tooltip>
          <Tooltip label={fullscreen ? 'Exit full screen (Esc)' : 'Expand to full screen'}>
            <BrowserHeadButton
              tone={fullscreen ? 'info' : 'regular'}
              aria-label={fullscreen ? 'Exit full screen' : 'Expand browser to full screen'}
              aria-pressed={fullscreen}
              disabled={fresh}
              onClick={() => setFullscreen((cur) => !cur)}
            >
              {fullscreen ? <Icon glyph={IconCollapse} role="ui" /> : <Icon glyph={IconExpand} role="ui" />}
            </BrowserHeadButton>
          </Tooltip>
          <BrowserNativeActions nodeId={node.id} fresh={fresh} detached={detached} viewportRef={viewportRef} setDetachError={setDetachError} picker={picker} onSendToTerminal={onSendToTerminal} />
          {panel && <Tooltip label="Move to grid"><BrowserNavigationButton aria-label="Move to grid" onClick={() => onMoveToGrid?.(active.url ?? '')}><Icon glyph={IconExternal} role="ui" /></BrowserNavigationButton></Tooltip>}
          <Tooltip label="Close">
            <BrowserHeadButton
              tone="danger"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon glyph={IconClose} role="ui" />
            </BrowserHeadButton>
          </Tooltip>
        </PaneHeadActions>
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
              <BrowserHeadButton
                tone={detached ? 'info' : 'regular'}
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
              </BrowserHeadButton>
            </Tooltip>
          )}
          {isTauri() && (
            <Tooltip
              label={!onSendToTerminal ? 'Select element unavailable: focus a live agent pane first' : picker.enabled ? 'Stop selecting elements (Esc)' : 'Select element · click to hand it to the focused agent'}
            >
              <BrowserHeadButton
                tone={picker.enabled ? 'info' : 'regular'}
                aria-label={picker.enabled ? 'Stop selecting elements' : 'Select a page element'}
                aria-pressed={picker.enabled}
                disabled={fresh || !onSendToTerminal}
                data-testid={`browser-picker-toggle-${nodeId}`}
                onClick={picker.toggle}
              >
                <Icon glyph={IconTarget} role="ui" />
              </BrowserHeadButton>
            </Tooltip>
          )}
  </>
}

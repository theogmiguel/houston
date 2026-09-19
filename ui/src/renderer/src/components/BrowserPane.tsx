import { useEffect, useRef, useState } from 'react'
import { GLOW_DANGER, GLOW_WARNING, RING_ACCENT_ICON } from './shadowChrome'
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
  IconGlobe,
  IconHistory,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTarget
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
import {
  type BrowserTab,
  TabWebview,
  TabsPopover,
  clearRecents,
  faviconInitial,
  hostLabel,
  loadRecents,
  loadTabs,
  toNavUrl,
  useBrowserTabs
} from './browserTabs'
import { useBrowserNav } from './browserNav'
import { tabsStorageKey } from './browserTabsKey'
import { Icon } from './Icon'

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
  focusUrlRequest?: number
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
  focusUrlRequest = 0
}: Props): React.JSX.Element {
  const tabsKey = tabsStorageKey(node.id)
  const [restored] = useState(() => seedTabs(tabsKey, node.url))
  const [urlInput, setUrlInput] = useState(
    () => restored.tabs.find((t) => t.id === restored.activeTabId)?.url ?? ''
  )
  const [urlFocused, setUrlFocused] = useState(false)
  const [popover, setPopover] = useState(false)
  const [failMsg, setFailMsg] = useState<string | null>(null)
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

  const picker = usePickerController(node.id, fresh, onSendToTerminal)

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
        <div className="relative flex-1 min-w-0 flex items-center">
          <span
            className={`absolute left-1.5 top-1/2 -translate-y-1/2 inline-flex pointer-events-none [transition:color_0.16s_ease] ${urlFocused ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}
            aria-hidden
          >
            <Icon glyph={IconSearch} role="label" />
          </span>
          <input
            ref={urlRef}
            aria-label="Address and search bar"
            className={`${URL_INPUT_CLS} pl-[22px]`}
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
          {isTauri() && (
            <Tooltip label={detached ? 'Reattach into the grid' : 'Detach into its own window'}>
              <button
                className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${detached ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
                aria-label={detached ? 'Reattach browser into the grid' : 'Detach browser into its own window'}
                aria-pressed={detached}
                disabled={fresh}
                data-testid={`browser-detach-${node.id}`}
                onClick={() => {
                  setDetachError(null)
                  const handle = viewportRef.current
                  if (!handle) return
                  const op = detached ? handle.reattach() : handle.detach()
                  void op.catch((err: unknown) => {
                    setDetachError(
                      `${detached ? 'Reattaching' : 'Detaching'} ${JSON.stringify(node.id)} failed: ` +
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
              label={picker.enabled ? 'Stop selecting elements (Esc)' : 'Select an element to describe a change'}
            >
              <button
                className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${picker.enabled ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
                aria-label={picker.enabled ? 'Stop selecting elements' : 'Select a page element'}
                aria-pressed={picker.enabled}
                disabled={fresh}
                data-testid={`browser-picker-toggle-${node.id}`}
                onClick={picker.toggle}
              >
                <Icon glyph={IconTarget} role="ui" />
              </button>
            </Tooltip>
          )}
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
      {failMsg && (
        <div
          className="flex items-center gap-2 py-[6px] pr-3 pl-4 flex-none [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border-b border-[color-mix(in_srgb,var(--danger)_28%,transparent)] z-[var(--z-base)]"
          role="alert"
        >
          <span className={`flex-none w-1.5 h-1.5 rounded-[999px] bg-danger shadow-[${GLOW_DANGER}]`} aria-hidden />
          <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{failMsg}</span>
          <button
            type="button"
            className="btn flex-none py-0.5 px-[7px] border-0 rounded-[var(--tr-radius-input)] bg-transparent text-inherit font-semibold [transition:background_0.12s_ease] hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]"
            onClick={() => {
              setFailMsg(null)
              reload(false)
            }}
          >
            Retry
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
      <PickerStrip id={node.id} controller={picker} />
      {tabs.some((t) => t.url !== null) && !surfaceMountFailed && (
        <BrowserFullscreen
          active={fullscreen}
          onExit={() => setFullscreen(false)}
          hostClassName={WEBVIEW_HOST_CLS}
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
            id={node.id}
            workspaceDir={workspaceDir}
            url={(active.url ?? tabs.find((t) => t.url !== null)?.url) as string}
            className={fullscreen ? WEBVIEW_HOST_CLS : `${WEBVIEW_HOST_CLS} ${SURFACE_RADIUS_CLS}`}
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
                    if (t.id === active.id) setFailMsg(desc)
                  }}
                />
              ))}
          </BrowserViewport>
        </BrowserFullscreen>
      )}
      {fresh && (
        <div className="h-full w-full flex items-center justify-center py-6 px-4 overflow-y-auto">
          <div className="w-full max-w-[300px] flex flex-col items-start gap-3">
            <div
              className="inline-flex items-center justify-center w-8 h-8 rounded-[8px] bg-surface border border-border text-text-secondary"
              aria-hidden
            >
              <Icon glyph={IconGlobe} role="heading" />
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="m-0 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-text-primary leading-[1.2]">
                Browser
              </h2>
              <p className="m-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-text-muted">
                Enter a URL, or pick a recent one below.
              </p>
            </div>
            <button
              type="button"
              className="btn inline-flex items-center gap-1.5 py-1 px-2.5 rounded-[var(--tr-radius-sm)] bg-surface text-text-primary border border-border [font-size:var(--tr-text-small-size)] font-medium [transition:background_0.14s_ease,border-color_0.14s_ease] hover:bg-[color-mix(in_srgb,var(--card-bg)_100%,var(--text-primary)_6%)] hover:border-[color-mix(in_srgb,var(--border)_100%,var(--text-primary)_15%)] active:scale-[0.98]"
              data-testid="browser-pane-open-cta"
              onClick={() => urlRef.current?.focus()}
            >
              <Icon glyph={IconPlus} role="label" />
              <span>Open a page</span>
            </button>
            {recents.length > 0 && (
              <div className="w-full flex flex-col gap-1.5">
                <div className="flex items-center gap-[5px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-text-muted">
                  <Icon glyph={IconHistory} role="label" />
                  Recently opened
                  <button
                    type="button"
                    className="btn ml-auto py-px px-1.5 rounded-[var(--tr-radius-input)] bg-transparent border-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-text-muted [transition:color_0.12s_ease,background_0.12s_ease] hover:text-text-primary hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]"
                    data-testid="browser-pane-clear-recents"
                    onClick={() => {
                      clearRecents()
                      setRecents([])
                    }}
                  >
                    Clear
                  </button>
                </div>
                <div className="flex flex-col gap-px">
                  {recents.map((u) => (
                    <Tooltip key={u} label={u}>
                      <button
                        type="button"
                        className="btn group flex items-center gap-2.5 py-[6px] px-2 rounded-[var(--tr-radius-sm)] bg-transparent border-0 text-text-secondary text-left w-full [transition:background_0.12s_ease,color_0.12s_ease] hover:bg-[color-mix(in_srgb,var(--card-bg)_80%,transparent)] hover:text-text-primary active:bg-surface"
                        onClick={() => openUrl(u)}
                      >
                        <span
                          className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--tr-radius-sm)] flex-none text-text-muted bg-surface border border-border font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase group-hover:text-text-secondary"
                          aria-hidden
                        >
                          {faviconInitial(u)}
                        </span>
                        <span className="flex flex-col gap-px min-w-0 flex-1">
                          <span className="[font-size:var(--tr-text-small-size)] font-medium text-inherit whitespace-nowrap overflow-hidden text-ellipsis">
                            {hostLabel(u)}
                          </span>
                          <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-text-muted whitespace-nowrap overflow-hidden text-ellipsis">
                            {u}
                          </span>
                        </span>
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

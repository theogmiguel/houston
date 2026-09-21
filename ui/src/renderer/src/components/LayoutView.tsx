import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { ThemeName } from '../theme'
import { SessionPane } from './SessionPane'
import type { PaneRoster } from './DelegationCard'
import type { HandoffSource } from './PaneHandoff'
import { SurfaceBoundary } from './SurfaceBoundary'
import type { RegisterOutput } from '../pane/TerminalPane'
import { EditorLeaf } from './EditorLeaf'

// Heavy panes no grid opens on launch stay behind `lazy()` to stay off the boot
// chunk; `bundle-budget.json` names them so a static import fails with a cause.
const FilesPane = lazy(() => import('./FilesPane').then((m) => ({ default: m.FilesPane })))

const BrowserPane = lazy(() => import('./BrowserPane').then((m) => ({ default: m.BrowserPane })))
import { SkillsLeaf, type SkillDistributionProps } from './SkillsLeaf'
import { ExpandedContext } from '../layout/expandedContext'
import { GridHiddenContext } from '../layout/gridHiddenContext'
import { WarmContext } from '../layout/warmContext'
import {
  computeRects,
  paneKey,
  quadrant,
  setRatio,
  clampSplitRatio,
  MIN_PANE_PX,
  type LayoutNode,
  type PaneKey,
  type GridSlot,
  type PaneNode,
  type Side,
  type SplitSide,
  type SplitterRect
} from '../layout/tree'
import { isDetachable, type DetachPayload, type PaneType } from '../layout/paneDetach'
import { StackTabs } from './StackTabs'
import { materialAttrs } from './material'

interface Props {
  tree: LayoutNode
  sessions: Map<number, SessionInfo>
  /** Branch per session id, once git has answered for that pane's cwd. */
  branches?: Map<number, string>
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
  viewAll: boolean
  client: HoustonClient
  theme: ThemeName
  fontSize: number
  fontFamily?: string
  shiftEnterNewline?: boolean
  openLinksInPane?: boolean
  onOpenUrlInPane?: (url: string) => void
  copyOnSelect: boolean
  stripBoxGlyphs: boolean
  activeId: number | null
  activeLeafId?: string | null
  connected: boolean
  expandedId: PaneKey | null
  gridHidden?: boolean
  warm?: boolean
  registerOutput: RegisterOutput
  shellIntegration: boolean
  workspaceDir: string
  onReconnectSsh: (id: number) => void
  onActivate: (id: number) => void
  onExpand: (key: PaneKey) => void
  onZoom: (dir: 1 | -1 | 0) => void
  onShellZoom: (dir: 1 | -1 | 0) => void
  onSplit: (session: number, side: SplitSide) => void
  onAddPane?: (anchor: PaneKey, rect: DOMRect) => void
  onMove: (dragged: PaneKey, target: PaneKey, side: SplitSide) => void
  onSwap: (a: PaneKey, b: PaneKey) => void
  onStackWith?: (dragged: PaneKey, target: PaneKey) => void
  onSelectStackTab?: (stackId: string, key: PaneKey) => void
  onUnstack?: (key: PaneKey) => void
  onResize: (path: number[], index: number, ratio: number) => void
  onCloseBrowser: (id: string) => void
  onBrowserNavigate: (id: string, url: string) => void
  onCloseEditor: (id: string) => void
  onSplitEditor: (id: string, side: SplitSide) => void
  newPaneOrigins?: Map<PaneKey, SplitSide>
  skillDistribution?: SkillDistributionProps
  onRunSkill?: (invoke: string) => void
  onCloseSkills?: (id: string) => void
  onCloseFiles?: (id: string) => void
  onHandoff: (source: HandoffSource) => void
  onSwapAdjacent?: (session: number, offset: 1 | -1) => void
  onOpenFile: (session: number, path: string, line?: number, col?: number) => void
  onOpenDir: (path: string) => void
  onSendToTerminal?: (text: string) => void
  onNativeError?: (text: string) => void
  onDetach?: (payload: DetachPayload) => void
  focusUrlRequest?: number
}

interface DropTarget {
  key: PaneKey
  side: Side
  stack: boolean
}

// Lives on a ref, never React state: a drag that stored its own position would
// re-render the grid a hundred times a second. `frame` coalesces the pointer
// stream to one `computeRects` paint per animation frame.
interface SplitterDrag {
  sp: SplitterRect
  pointerId: number
  el: HTMLElement
  paneEls: HTMLElement[]
  paneKeys: PaneKey[]
  splitterEls: HTMLElement[]
  horizontal: boolean
  startPx: number
  spanPx: number
  latestPx: number
  frame: number | null
  moved: boolean
}

function splitterRatio(sp: SplitterRect): number {
  const pos = sp.dir === 'row' ? sp.rect.x : sp.rect.y
  return sp.spanPct > 0 ? (pos - sp.startPct) / sp.spanPct : 0.5
}

function ownsDrop(node: GridSlot, target: PaneKey): boolean {
  return (
    paneKey(node) === target ||
    (node.kind === 'stack' && node.children.some((c) => paneKey(c) === target))
  )
}

const DZ_RECT: Record<Side, string> = {
  left: 'left-0 top-0 w-1/2 h-full',
  right: 'right-0 top-0 w-1/2 h-full',
  top: 'left-0 top-0 w-full h-1/2',
  bottom: 'left-0 bottom-0 w-full h-1/2',
  center: 'inset-0'
}

const DZ_LABEL: Record<Side, string> = {
  left: 'Split left',
  right: 'Split right',
  top: 'Split up',
  bottom: 'Split down',
  center: 'Swap'
}

function PaneDragOverlay({
  drop,
  source
}: {
  drop: DropTarget | null
  source: boolean
}): React.JSX.Element | null {
  if (source) {
    return (
      <div
        data-testid="pane-drag-scrim"
        className="absolute inset-0 z-[calc(var(--z-pane)+3)] pointer-events-none bg-overlay"
        aria-hidden="true"
      />
    )
  }
  if (drop === null) return null
  return (
    <div
      data-testid="pane-dropzone"
      data-side={drop.side}
      className={`dropzone ${DZ_RECT[drop.side]} absolute z-[calc(var(--z-pane)+1)] flex items-center justify-center pointer-events-none border-2 border-dashed [border-color:var(--accent)] rounded-[var(--tr-radius-md)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] motion-safe:[animation:term-enter_var(--animate-t-fast)_var(--animate-ease-panel)]`}
      aria-hidden="true"
    >
      {}
      <span
        className="inline-flex items-center h-[var(--h-pill)] px-2 whitespace-nowrap rounded-[var(--tr-radius-sm)] bg-[var(--accent)] text-white [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] shadow-[var(--shadow-2)]"
      >
        {drop.stack ? 'Stack' : DZ_LABEL[drop.side]}
      </span>
    </div>
  )
}

const SPLITTER_CLASS: Record<'row' | 'col', string> = {
  row: 'w-2 -translate-x-1 cursor-col-resize after:w-px after:mx-auto',
  col: 'h-2 -translate-y-1 cursor-row-resize after:h-px after:my-auto'
}

const SPLITTER_KEY_STEP = 0.04

const GUTTER = 'var(--pane-gutter)'
const HALF_GUTTER = 'calc(var(--pane-gutter) / 2)'
const EDGE_EPS = 0.01
function gutterInsets(rect: { x: number; y: number; w: number; h: number }): {
  left: string
  top: string
  right: string
  bottom: string
} {
  const atLeft = rect.x <= EDGE_EPS
  const atTop = rect.y <= EDGE_EPS
  const atRight = rect.x + rect.w >= 100 - EDGE_EPS
  const atBottom = rect.y + rect.h >= 100 - EDGE_EPS
  return {
    left: atLeft ? GUTTER : HALF_GUTTER,
    top: atTop ? GUTTER : HALF_GUTTER,
    right: atRight ? GUTTER : HALF_GUTTER,
    bottom: atBottom ? GUTTER : HALF_GUTTER
  }
}

function paneSlotGeometry(rect: { x: number; y: number; w: number; h: number }): {
  left: string
  top: string
  width: string
  height: string
} {
  const gutter = gutterInsets(rect)
  return {
    left: `calc(${rect.x}% + ${gutter.left})`,
    top: `calc(${rect.y}% + ${gutter.top})`,
    width: `calc(${rect.w}% - ${gutter.left} - ${gutter.right})`,
    height: `calc(${rect.h}% - ${gutter.top} - ${gutter.bottom})`
  }
}

const PANE_GROW_ORIGIN: Record<SplitSide, string> = {
  left: 'right_center',
  right: 'left_center',
  top: 'center_bottom',
  bottom: 'center_top'
}

function paneGrowCls(side: SplitSide): string {
  return `motion-safe:[animation:term-enter_var(--motion-panel-t)_var(--motion-panel-ease)] [transform-origin:${PANE_GROW_ORIGIN[side]}]`
}

function parsePaneKey(raw: string): PaneKey {
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

function splitterLabel(sp: SplitterRect): string {
  const axis = sp.dir === 'row' ? 'left and right' : 'top and bottom'
  const pos = `${sp.index + 1}/${sp.index + 2}`
  const group = sp.path.length > 0 ? ` in section ${sp.path.map((i) => i + 1).join('.')}` : ''
  return `Resize ${axis} panes ${pos}${group}`
}

interface PaneBodyOpts {
  props: Props
  expanded: boolean
  onHeaderPointerDown: (e: React.PointerEvent) => void
  onSessionHeaderPointerDown?: (id: number, e: React.PointerEvent) => void
  hiddenByExpand?: boolean
  dropzoneActive?: boolean
}

function renderPaneBody(node: PaneNode, opts: PaneBodyOpts): React.JSX.Element | null {
  const {
    props,
    expanded,
    onHeaderPointerDown,
    onSessionHeaderPointerDown = (_id, e) => onHeaderPointerDown(e),
    hiddenByExpand = false,
    dropzoneActive = false
  } = opts
  const workspaceDir = props.workspaceDir
  if (node.kind === 'browser') {
    return (
      <SurfaceBoundary label="Browser">
        <Suspense fallback={<div className="flex-1" />}>
          <BrowserPane
            node={node}
            workspaceDir={workspaceDir}
            onNavigate={(url) => props.onBrowserNavigate(node.id, url)}
            onClose={() => props.onCloseBrowser(node.id)}
            onHeaderPointerDown={onHeaderPointerDown}
            active={props.activeLeafId === node.id}
            hiddenByExpand={hiddenByExpand}
            dropzoneActive={dropzoneActive}
            onSendToTerminal={props.onSendToTerminal}
            onNativeError={props.onNativeError}
            focusUrlRequest={props.focusUrlRequest}
          />
        </Suspense>
      </SurfaceBoundary>
    )
  }
  if (node.kind === 'editor') {
    return (
      <SurfaceBoundary label="Editor">
        <EditorLeaf
          node={node}
          workspaceDir={workspaceDir}
          onClose={() => props.onCloseEditor(node.id)}
          onSplit={(side) => props.onSplitEditor(node.id, side)}
          onHeaderPointerDown={onHeaderPointerDown}
          active={props.activeLeafId === node.id}
          expanded={expanded}
          onExpand={props.onExpand}
        />
      </SurfaceBoundary>
    )
  }
  if (node.kind === 'files') {
    return (
      <SurfaceBoundary label="Files">
        <Suspense fallback={<div className="flex-1" />}>
          <FilesPane
            node={node}
            workspaceDir={workspaceDir}
            onClose={() => props.onCloseFiles?.(node.id)}
            onHeaderPointerDown={onHeaderPointerDown}
            active={props.activeLeafId === node.id}
            expanded={expanded}
            onExpand={props.onExpand}
            onError={props.onNativeError}
          />
        </Suspense>
      </SurfaceBoundary>
    )
  }
  if (node.kind === 'skills') {
    return (
      <SurfaceBoundary label="Skills">
        <SkillsLeaf
          client={props.client}
          node={node}
          dir={workspaceDir}
          onRun={props.onRunSkill}
          {...props.skillDistribution}
          onClose={() => props.onCloseSkills?.(node.id)}
          onHeaderPointerDown={onHeaderPointerDown}
          expanded={expanded}
          onExpand={props.onExpand}
        />
      </SurfaceBoundary>
    )
  }
  if (node.kind === 'git') return null
  const info = props.sessions.get(node.session)
  if (!info) return null
  return (
    <SurfaceBoundary label={`Pane ${info.title}`}>
      <SessionPane
        client={props.client}
        info={info}
        theme={props.theme}
        active={props.activeId === node.session}
        connected={props.connected}
        fontSize={props.fontSize}
        fontFamily={props.fontFamily}
        shiftEnterNewline={props.shiftEnterNewline}
        openLinksInPane={props.openLinksInPane}
        onOpenUrlInPane={props.onOpenUrlInPane}
        copyOnSelect={props.copyOnSelect}
        stripBoxGlyphs={props.stripBoxGlyphs}
        showProject={expanded ? false : props.viewAll}
        branch={props.branches?.get(node.session) ?? null}
        registerOutput={props.registerOutput}
        shellIntegration={props.shellIntegration}
        onReconnectSsh={props.onReconnectSsh}
        onActivate={props.onActivate}
        onExpand={props.onExpand}
        expanded={expanded}
        onZoom={props.onZoom}
        onShellZoom={props.onShellZoom}
        onSplit={props.onSplit}
        onAddPane={props.onAddPane}
        onHeaderPointerDown={onSessionHeaderPointerDown}
        onHandoff={props.onHandoff}
        onSwapAdjacent={props.onSwapAdjacent}
        onOpenFile={props.onOpenFile}
        onOpenDir={props.onOpenDir}
        roster={props.roster}
        onFocusPane={props.onFocusPane}
      />
    </SurfaceBoundary>
  )
}

function LayoutViewImpl(props: Props): React.JSX.Element {
  const { tree, sessions, onMove, onSwap, onResize, onDetach, workspaceDir, onStackWith } = props
  const gridHidden = props.gridHidden ?? false
  const warm = props.warm ?? false
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragKey, setDragKey] = useState<PaneKey | null>(null)
  const [resizing, setResizing] = useState(false)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const dropRef = useRef<DropTarget | null>(null)
  dropRef.current = drop

  const { leaves, splitters } = computeRects(tree)

  const orderedLeaves = [...leaves].sort((a, b) => {
    const ka = String(paneKey(a.node))
    const kb = String(paneKey(b.node))
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const startPaneDrag = useCallback(
    (key: PaneKey, paneType: PaneType, e: React.PointerEvent): void => {
      const startX = e.clientX
      const startY = e.clientY
      let active = false
      let sidebarRow: HTMLElement | null = null
      let alt = false
      let zone: { key: PaneKey; side: Side } | null = null
      const publish = (): void => {
        setDrop(
          zone === null
            ? null
            : { ...zone, stack: zone.side === 'center' && alt && onStackWith != null }
        )
      }
      const onAlt = (ev: KeyboardEvent): void => {
        if (ev.altKey === alt) return
        alt = ev.altKey
        publish()
      }
      const clearSidebarHighlight = (): void => {
        if (sidebarRow) {
          sidebarRow.style.outline = ''
          sidebarRow.style.outlineOffset = ''
          sidebarRow = null
        }
      }
      const move = (ev: PointerEvent): void => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
          active = true
          setDragKey(key)
        }
        alt = ev.altKey
        const el = document.elementFromPoint(ev.clientX, ev.clientY)
        if (isDetachable(paneType)) {
          const wsRow = el?.closest('[data-ws-idx]') as HTMLElement | null
          if (wsRow) {
            zone = null
            publish()
            if (sidebarRow !== wsRow) {
              clearSidebarHighlight()
              sidebarRow = wsRow
              sidebarRow.style.outline = '2px solid var(--accent)'
              sidebarRow.style.outlineOffset = '-2px'
            }
            return
          }
        }
        clearSidebarHighlight()
        const paneEl = el?.closest('[data-panekey]') as HTMLElement | null
        if (!paneEl) {
          zone = null
          publish()
          return
        }
        const target = parsePaneKey(paneEl.getAttribute('data-panekey') ?? '')
        if (target === key) {
          zone = null
          publish()
          return
        }
        zone = {
          key: target,
          side: quadrant(paneEl.getBoundingClientRect(), ev.clientX, ev.clientY)
        }
        publish()
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('keydown', onAlt)
        window.removeEventListener('keyup', onAlt)
        const detachTarget = sidebarRow
        clearSidebarHighlight()
        const target = dropRef.current
        if (active && detachTarget && isDetachable(paneType) && onDetach) {
          if (typeof key === 'number' && sessions.has(key)) {
            onDetach({
              paneId: key,
              sourceWorkspaceId: workspaceDir,
              paneType,
              sessionId: key
            })
          }
        } else if (active && target) {
          if (target.stack && onStackWith) {
            onStackWith(key, target.key)
          } else if (target.side === 'center') {
            onSwap(key, target.key)
          } else {
            onMove(key, target.key, target.side)
          }
        }
        setDragKey(null)
        setDrop(null)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('keydown', onAlt)
      window.addEventListener('keyup', onAlt)
    },
    [onMove, onSwap, onStackWith, sessions, onDetach, workspaceDir]
  )

  const dragRef = useRef<SplitterDrag | null>(null)

  useEffect(() => {
    return () => {
      const d = dragRef.current
      if (d?.frame != null) window.cancelAnimationFrame(d.frame)
      if (d) delete d.el.dataset.dragging
      dragRef.current = null
    }
  }, [])

  const paintSplitterDrag = (d: SplitterDrag, ratio: number): void => {
    const live = computeRects(setRatio(tree, d.sp.path, d.sp.index, ratio))
    const rectByKey = new Map(live.leaves.map((l) => [paneKey(l.node), l.rect]))
    d.paneKeys.forEach((key, i) => {
      const el = d.paneEls[i]
      const r = rectByKey.get(key)
      if (!el || !r) return
      Object.assign(el.style, paneSlotGeometry(r))
    })
    live.splitters.forEach((s, i) => {
      const el = d.splitterEls[i]
      if (!el) return
      el.style.left = `${s.rect.x}%`
      el.style.top = `${s.rect.y}%`
      if (s.dir === 'row') el.style.height = `${s.rect.h}%`
      else el.style.width = `${s.rect.w}%`
    })
    d.el.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }

  const ratioAtPointer = (d: SplitterDrag): number =>
    clampSplitRatio((d.latestPx - d.startPx) / d.spanPx, d.spanPx)

  const finishSplitterDrag = (d: SplitterDrag, commit: boolean): void => {
    dragRef.current = null
    if (d.frame !== null) window.cancelAnimationFrame(d.frame)
    delete d.el.dataset.dragging
    if (d.el.hasPointerCapture?.(d.pointerId)) d.el.releasePointerCapture(d.pointerId)
    setResizing(false)
    if (!d.moved) return
    if (commit) {
      onResize(d.sp.path, d.sp.index, ratioAtPointer(d))
      return
    }
    paintSplitterDrag(d, splitterRatio(d.sp))
  }

  const startSplitterDrag = (sp: SplitterRect, e: React.PointerEvent): void => {
    if (dragRef.current !== null) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const horizontal = sp.dir === 'row'
    const axisPx = horizontal ? rect.width : rect.height
    const spanPx = (sp.spanPct / 100) * axisPx
    if (spanPx <= 2 * MIN_PANE_PX) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const d: SplitterDrag = {
      sp,
      pointerId: e.pointerId,
      el,
      paneEls: Array.from(container.querySelectorAll<HTMLElement>(':scope > .pane-slot')),
      paneKeys: orderedLeaves.map((l) => paneKey(l.node)),
      splitterEls: Array.from(container.querySelectorAll<HTMLElement>(':scope > .splitter')),
      horizontal,
      startPx: (horizontal ? rect.left : rect.top) + (sp.startPct / 100) * axisPx,
      spanPx,
      latestPx: horizontal ? e.clientX : e.clientY,
      frame: null,
      moved: false
    }
    dragRef.current = d
    el.dataset.dragging = 'true'
    el.setPointerCapture?.(e.pointerId)
    setResizing(true)
  }

  const moveSplitterDrag = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (d === null || d.pointerId !== e.pointerId) return
    d.latestPx = d.horizontal ? e.clientX : e.clientY
    d.moved = true
    if (d.frame !== null) return
    d.frame = window.requestAnimationFrame(() => {
      d.frame = null
      if (dragRef.current !== d) return
      paintSplitterDrag(d, ratioAtPointer(d))
    })
  }

  const endSplitterDrag = (e: React.PointerEvent, commit: boolean): void => {
    const d = dragRef.current
    if (d === null || d.pointerId !== e.pointerId) return
    finishSplitterDrag(d, commit)
  }

  const handleSplitterKeyDown = useCallback(
    (sp: SplitterRect, e: React.KeyboardEvent): void => {
      const horizontal = sp.dir === 'row'
      let delta = 0
      if (horizontal) {
        if (e.key === 'ArrowRight') delta = SPLITTER_KEY_STEP
        else if (e.key === 'ArrowLeft') delta = -SPLITTER_KEY_STEP
        else return
      } else {
        if (e.key === 'ArrowDown') delta = SPLITTER_KEY_STEP
        else if (e.key === 'ArrowUp') delta = -SPLITTER_KEY_STEP
        else return
      }
      e.preventDefault()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const spanPx = ((horizontal ? rect.width : rect.height) * sp.spanPct) / 100
      if (spanPx <= 0) return
      onResize(sp.path, sp.index, clampSplitRatio(splitterRatio(sp) + delta, spanPx))
    },
    [onResize]
  )

  const expandedIdRef = useRef(props.expandedId)
  expandedIdRef.current = props.expandedId

  const handleHeaderPointerDown = useCallback(
    (id: number, e: React.PointerEvent): void => {
      if (expandedIdRef.current === id) return
      startPaneDrag(id, 'terminal', e)
    },
    [startPaneDrag]
  )

  return (
    <ExpandedContext.Provider value={props.expandedId}>
    <GridHiddenContext.Provider value={gridHidden}>
      <WarmContext.Provider value={warm}>
    <div
      {...materialAttrs('shell')}
      className={`layout relative flex-1 min-h-0 overflow-hidden bg-[var(--gutter-bg)] ${dragKey !== null ? 'dragging cursor-grabbing' : ''} ${resizing ? 'resizing' : ''}`}
      ref={containerRef}
    >
      {orderedLeaves.map(({ node, rect }) => {
        const key = paneKey(node)
        const slotDrop = drop !== null && ownsDrop(node, drop.key) ? drop : null
        const dragSrcCls = dragKey === key ? 'drag-src' : ''
        const isExpandedLeaf =
          props.expandedId != null &&
          (node.kind === 'stack'
            ? node.children.some((c) => paneKey(c) === props.expandedId)
            : paneKey(node) === props.expandedId)
        const hiddenByExpand = gridHidden || (props.expandedId != null && !isExpandedLeaf)
        const skipLayout = hiddenByExpand && node.kind === 'leaf'
        const geomRect = isExpandedLeaf && !gridHidden ? { x: 0, y: 0, w: 100, h: 100 } : rect
        const style: React.CSSProperties = {
          ...paneSlotGeometry(geomRect),
          zIndex: isExpandedLeaf && !gridHidden ? 'var(--z-pane)' : undefined,
          visibility: hiddenByExpand ? 'hidden' : undefined,
          contentVisibility: skipLayout ? 'hidden' : undefined,
          contain: skipLayout ? 'strict' : undefined
        }
        const growSide = node.kind !== 'stack' ? props.newPaneOrigins?.get(key) : undefined
        const growCls = growSide ? paneGrowCls(growSide) : ''
        if (node.kind === 'stack') {
          const displayIdx = (() => {
            if (props.expandedId != null) {
              const idx = node.children.findIndex((c) => paneKey(c) === props.expandedId)
              if (idx !== -1) return idx
            }
            return Math.min(node.activeIndex, node.children.length - 1)
          })()
          const noHeaderDrag = (): void => {}
          const renderChildBody = (child: PaneNode): React.JSX.Element | null => {
            const childIsExpanded = isExpandedLeaf && paneKey(child) === props.expandedId
            return renderPaneBody(child, {
              props,
              expanded: childIsExpanded,
              onHeaderPointerDown: noHeaderDrag,
              onSessionHeaderPointerDown: noHeaderDrag
            })
          }
          return (
            <div
              key={node.id}
              data-testid="stack-slot"
              className="pane-slot absolute flex flex-col overflow-hidden @container"
              style={style}
            >
              <StackTabs
                stack={node}
                displayedIndex={displayIdx}
                sessions={sessions}
                onSelect={(k) => props.onSelectStackTab?.(node.id, k)}
                onUnstack={(k) => props.onUnstack?.(k)}
              />
              <div className="flex-1 min-h-0 relative flex">
                {node.children.map((child, i) => {
                  const shown = i === displayIdx
                  return (
                    <div
                      key={String(paneKey(child))}
                      data-testid="stack-child-slot"
                      data-shown={shown}
                      className="absolute inset-0 flex"
                      style={
                        shown
                          ? undefined
                          : {
                              visibility: 'hidden',
                              contentVisibility: child.kind === 'leaf' ? 'hidden' : undefined,
                              contain: child.kind === 'leaf' ? 'strict' : undefined
                            }
                      }
                    >
                      {renderChildBody(child)}
                    </div>
                  )
                })}
              </div>
              <PaneDragOverlay drop={slotDrop} source={false} />
            </div>
          )
        }
        if (node.kind === 'browser') {
          const browserCollapsed = props.expandedId != null && !isExpandedLeaf
          return (
            <div
              key={node.id}
              className={`pane-slot absolute flex overflow-hidden @container ${dragSrcCls} ${growCls}`}
              style={style}
            >
              {renderPaneBody(node, {
                props,
                expanded: isExpandedLeaf,
                onHeaderPointerDown: (e) => {
                  if ((e.target as HTMLElement).closest('button, input')) return
                  startPaneDrag(node.id, 'browser', e)
                },
                hiddenByExpand: browserCollapsed,
                dropzoneActive: dragKey !== null
              })}
              <PaneDragOverlay drop={slotDrop} source={dragKey === key} />
            </div>
          )
        }
        if (node.kind === 'editor') {
          return (
            <div
              key={node.id}
              className={`pane-slot absolute flex overflow-hidden @container ${dragSrcCls} ${growCls}`}
              style={style}
            >
              {renderPaneBody(node, {
                props,
                expanded: isExpandedLeaf,
                onHeaderPointerDown: (e) => {
                  if ((e.target as HTMLElement).closest('button, input')) return
                  startPaneDrag(node.id, 'editor', e)
                }
              })}
              <PaneDragOverlay drop={slotDrop} source={dragKey === key} />
            </div>
          )
        }
        if (node.kind === 'files') {
          return (
            <div
              key={node.id}
              className={`pane-slot absolute flex overflow-hidden @container ${dragSrcCls} ${growCls}`}
              style={style}
            >
              {renderPaneBody(node, {
                props,
                expanded: isExpandedLeaf,
                onHeaderPointerDown: (e) => {
                  if ((e.target as HTMLElement).closest('button')) return
                  startPaneDrag(node.id, 'files', e)
                }
              })}
              <PaneDragOverlay drop={slotDrop} source={dragKey === key} />
            </div>
          )
        }
        if (node.kind === 'skills') {
          return (
            <div
              key={node.id}
              className={`pane-slot absolute flex overflow-hidden @container ${dragSrcCls} ${growCls}`}
              style={style}
            >
              {renderPaneBody(node, {
                props,
                expanded: isExpandedLeaf,
                onHeaderPointerDown: (e) => {
                  if ((e.target as HTMLElement).closest('button, input')) return
                  startPaneDrag(node.id, 'skills', e)
                }
              })}
              <PaneDragOverlay drop={slotDrop} source={dragKey === key} />
            </div>
          )
        }
        if (node.kind !== 'leaf') return null
        if (!sessions.get(node.session)) return null
        return (
          <div
            key={node.session}
            className={`pane-slot absolute flex overflow-hidden ${dragSrcCls} ${growCls}`}
            style={style}
          >
            {renderPaneBody(node, {
              props,
              expanded: isExpandedLeaf,
              onHeaderPointerDown: (e) => handleHeaderPointerDown(node.session, e),
              // SessionPane alone takes `(id, e)` and already holds a stable
              // `useCallback` — hand it through unwrapped; a fresh closure would
              // defeat its `memo()` for every terminal pane, not just the dragged one.
              onSessionHeaderPointerDown: handleHeaderPointerDown
            })}
            <PaneDragOverlay drop={slotDrop} source={dragKey === key} />
          </div>
        )
      })}
      {props.expandedId == null && !gridHidden && splitters.map((sp, i) => (
        <div
          key={`sp-${sp.path.join('.')}-${sp.index}-${i}`}
          className={`splitter ${SPLITTER_CLASS[sp.dir]} absolute z-[var(--z-pane)] touch-none bg-transparent focus-visible:outline-none after:content-[''] after:absolute after:inset-0 after:rounded-[1px] after:bg-transparent motion-safe:after:[transition:background-color_0.1s_ease-out] focus-visible:after:bg-[var(--text-faint)] data-[dragging]:after:bg-[var(--text-faint)] ${dragKey !== null ? 'pointer-events-none' : ''}`}
          style={{
            left: `${sp.rect.x}%`,
            top: `${sp.rect.y}%`,
            width: sp.dir === 'row' ? undefined : `${sp.rect.w}%`,
            height: sp.dir === 'row' ? `${sp.rect.h}%` : undefined
          }}
          onPointerDown={(e) => startSplitterDrag(sp, e)}
          onPointerMove={moveSplitterDrag}
          onPointerUp={(e) => endSplitterDrag(e, true)}
          onPointerCancel={(e) => endSplitterDrag(e, false)}
          tabIndex={0}
          role="separator"
          aria-orientation={sp.dir === 'row' ? 'vertical' : 'horizontal'}
          aria-label={splitterLabel(sp)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(splitterRatio(sp) * 100)}
          onKeyDown={(e) => handleSplitterKeyDown(sp, e)}
        />
      ))}
    </div>
      </WarmContext.Provider>
    </GridHiddenContext.Provider>
    </ExpandedContext.Provider>
  )
}

export const LayoutView = memo(LayoutViewImpl)

import {
  appendToRoot,
  computeRects,
  insertBeside,
  leaf,
  preorderLeaves,
  preorderSessions,
  type LayoutNode,
  type PaneKey,
  type Rect,
  type SplitSide
} from '../layout/tree'
import { registerOwned } from './registration'

/** What a mounted terminal pane lends to size a pane that does not exist yet. */
export interface TerminalSizer {
  readonly host: HTMLElement
  mountBox(): { width: number; height: number } | null
  gridForBox(width: number, height: number): { cols: number; rows: number } | null
}

const sizers = new Map<number, TerminalSizer>()

export function registerTerminalSizer(session: number, sizer: TerminalSizer): () => void {
  return registerOwned(sizers, session, sizer)
}

export interface NewPanePlacement {
  readonly anchor: PaneKey
  readonly side: SplitSide
}

/** Where panes created now will sit, in percent of the grid: beside the anchor for a
 * split, appended to the root otherwise, as App places them on `session_created`. */
export function newPaneRects(
  tree: LayoutNode | null,
  placement: NewPanePlacement | null,
  count = 1
): Rect[] {
  const placeholders = Array.from({ length: count }, (_, index) => leaf(-index - 1))
  let next: LayoutNode | null = null
  if (placement && count === 1 && tree && preorderLeaves(tree).includes(placement.anchor)) {
    next = insertBeside(tree, placement.anchor, placeholders[0], placement.side)
  }
  const { leaves } = computeRects(
    next ?? placeholders.reduce<LayoutNode | null>((t, node) => appendToRoot(t, node), tree)!
  )
  const placed = placeholders.map((node) => leaves.find((l) => l.node === node)?.rect)
  // A split anchored inside a stack inserts nothing; App then appends the pane.
  if (next && placed.some((rect) => rect === undefined)) return newPaneRects(tree, null, count)
  return placed.map((rect) => rect ?? { x: 0, y: 0, w: 100, h: 100 })
}

const EDGE_EPS = 0.01

/** A slot's box in pixels, with the gutter insets `LayoutView` gives it. */
export function slotBox(
  rect: Rect,
  grid: { width: number; height: number },
  gutter: number
): { width: number; height: number } {
  const inset = (atEdge: boolean): number => (atEdge ? gutter : gutter / 2)
  return {
    width:
      (grid.width * rect.w) / 100 -
      inset(rect.x <= EDGE_EPS) -
      inset(rect.x + rect.w >= 100 - EDGE_EPS),
    height:
      (grid.height * rect.h) / 100 -
      inset(rect.y <= EDGE_EPS) -
      inset(rect.y + rect.h >= 100 - EDGE_EPS)
  }
}

// The layout size when a transform (a pane growing in) makes the client rect differ.
function settled(measured: number, layout: number): number {
  return layout && Math.abs(measured - layout) >= 1 ? layout : measured
}

interface Reference {
  readonly sizer: TerminalSizer
  readonly grid: { width: number; height: number }
  readonly gutter: number
  readonly chrome: { width: number; height: number }
}

function measureReference(tree: LayoutNode | null): Reference | null {
  for (const session of preorderSessions(tree)) {
    const sizer = sizers.get(session)
    const slot = sizer?.host.closest<HTMLElement>('.pane-slot')
    const gridEl = slot?.parentElement
    if (!sizer || !slot || !gridEl) continue
    // A stacked pane carries tab chrome a new pane will not have.
    if (sizer.host.closest('[data-testid="stack-child-slot"]')) continue
    if (getComputedStyle(slot).visibility === 'hidden') continue
    const mount = sizer.mountBox()
    const rect = slot.getBoundingClientRect()
    const slotRect = {
      width: settled(rect.width, slot.offsetWidth),
      height: settled(rect.height, slot.offsetHeight)
    }
    const gridRect = gridEl.getBoundingClientRect()
    const gutter = parseFloat(getComputedStyle(gridEl).getPropertyValue('--pane-gutter'))
    if (!mount || mount.width <= 0 || gridRect.width <= 0 || !Number.isFinite(gutter)) continue
    return {
      sizer,
      grid: { width: gridRect.width, height: gridRect.height },
      gutter,
      chrome: { width: slotRect.width - mount.width, height: slotRect.height - mount.height }
    }
  }
  return null
}

/** The PTY sizes for panes about to be created, so a CLI draws its first frame at the
 * width it will keep. `current` is the grid on screen, measured through a terminal it
 * shows; `target` is the grid the panes join. Null when nothing can be measured. */
export function newPaneSizes(options: {
  readonly current: LayoutNode | null
  readonly target: LayoutNode | null
  readonly placement?: NewPanePlacement | null
  readonly count?: number
}): Array<{ cols: number; rows: number } | null> {
  const count = options.count ?? 1
  const reference = measureReference(options.current)
  if (!reference) return Array.from({ length: count }, () => null)
  return newPaneRects(options.target, options.placement ?? null, count).map((rect) => {
    const slot = slotBox(rect, reference.grid, reference.gutter)
    return reference.sizer.gridForBox(
      slot.width - reference.chrome.width,
      slot.height - reference.chrome.height
    )
  })
}

/** `newPaneSizes` for one pane, as `createSession` fields. */
export function newPaneSize(
  current: LayoutNode | null,
  target: LayoutNode | null,
  placement: NewPanePlacement | null = null
): { cols?: number; rows?: number } {
  const [size] = newPaneSizes({ current, target, placement })
  return size ?? {}
}

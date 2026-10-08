import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// Below 720px, a 200px tree leaves less than ~500px for roughly 60 monospace columns.
export const FILES_SPLIT_MIN_WIDTH = 720
// Leaving the split needs this much less width, so a scrollbar (up to ~17px) that appears when
// the layout changes cannot flip it straight back and make the panel shake.
const FILES_SPLIT_HYSTERESIS = 24
// Keep room for tree labels without taking most of the editor's width.
export const FILES_TREE_MIN = 200
// Cap the tree before long labels consume the editor column.
export const FILES_TREE_MAX = 360
// The prototype reserves 288px normally, and 232px in a 760px panel.
const FILES_TREE_DEFAULT = 288
const FILES_TREE_COMPACT = 232
// Use the compact prototype width until the editor has room for the full tree.
const FILES_COMPACT_WIDTH = 800

export function clampTreeWidth(width: number): number {
  return Math.min(FILES_TREE_MAX, Math.max(FILES_TREE_MIN, width))
}

function loadSplit(workspace: string): { width: number | null; collapsed: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(`tr-files-split:${workspace}`) ?? 'null')
    return { width: Number.isFinite(value?.width) ? clampTreeWidth(value.width) : null, collapsed: value?.collapsed === true }
  } catch {
    return { width: null, collapsed: false }
  }
}

export function useFilesSplit(workspace: string, panel: boolean) {
  const containerRef = useRef<HTMLElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [saved, setSaved] = useState(() => loadSplit(workspace))
  const defaultWidth = containerWidth < FILES_COMPACT_WIDTH ? FILES_TREE_COMPACT : FILES_TREE_DEFAULT
  const width = saved.width ?? defaultWidth
  const wasSplit = useRef(false)
  const split = panel && containerWidth >= FILES_SPLIT_MIN_WIDTH - (wasSplit.current ? FILES_SPLIT_HYSTERESIS : 0)
  wasSplit.current = split

  useLayoutEffect(() => setSaved(loadSplit(workspace)), [workspace])

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element || !panel) return
    setContainerWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [panel])

  const update = useCallback((next: { width: number; collapsed: boolean }): void => {
    setSaved(next)
    try { localStorage.setItem(`tr-files-split:${workspace}`, JSON.stringify(next)) } catch { /* Storage may be disabled. */ }
  }, [workspace])

  return {
    containerRef, split, width, collapsed: saved.collapsed,
    resize: (next: number): void => update({ width: clampTreeWidth(next), collapsed: saved.collapsed }),
    reset: (): void => update({ width: defaultWidth, collapsed: saved.collapsed }),
    toggle: (): void => update({ width, collapsed: !saved.collapsed }),
    reveal: (): void => update({ width, collapsed: false })
  }
}

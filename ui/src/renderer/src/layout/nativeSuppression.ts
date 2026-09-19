// Native child webviews are sibling GTK widgets, not DOM nodes: z-index
// cannot paint host HTML over one, so surfaces assert a suppression reason
// while open and the child is hidden, never destroyed (a remount is costly).
import { useEffect } from 'react'
import { isTauri } from '../houston/host'

export type NativeSuppressionReason =
  | 'grid-hidden'
  | 'collapsed'
  | 'animating'
  | 'non-browser-view'
  | 'popover'
  | 'modal'
  | 'no-active-tab'

export type NativeSuppressionSink = (reason: NativeSuppressionReason, visible: boolean) => void

let sink: NativeSuppressionSink | null = null

export function setSuppressionSink(fn: NativeSuppressionSink | null): void {
  sink = fn
}

const counts = new Map<NativeSuppressionReason, number>()

export function assertNativeSuppression(reason: NativeSuppressionReason): void {
  const next = (counts.get(reason) ?? 0) + 1
  counts.set(reason, next)
  if (next === 1) sink?.(reason, false)
}

export function releaseNativeSuppression(reason: NativeSuppressionReason): void {
  const current = counts.get(reason) ?? 0
  if (current === 0) return
  const next = current - 1
  if (next === 0) {
    counts.delete(reason)
    sink?.(reason, true)
  } else {
    counts.set(reason, next)
  }
}

export function isNativelySuppressed(): boolean {
  return counts.size > 0
}

export function suppressedReasons(): NativeSuppressionReason[] {
  return [...counts.keys()]
}

export function __resetNativeSuppressionForTests(): void {
  counts.clear()
}

export function useNativeSuppression(reason: NativeSuppressionReason, active: boolean): void {
  useNativeSuppressionCount(reason, active ? 1 : 0)
}

// Counting, not one boolean effect per asserter: React runs every cleanup in a
// commit before any effect, so an overlay closing as another opens would fire a
// hide→show→hide round trip; holding `count` assertions makes it a no-op.
export function useNativeSuppressionCount(reason: NativeSuppressionReason, count: number): void {
  useEffect(() => {
    if (count <= 0 || !isTauri()) return
    for (let i = 0; i < count; i++) assertNativeSuppression(reason)
    return () => {
      for (let i = 0; i < count; i++) releaseNativeSuppression(reason)
    }
  }, [reason, count])
}

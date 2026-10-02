// Native child webviews are sibling GTK widgets, not DOM nodes: z-index
// cannot paint host HTML over one, so surfaces assert a suppression reason
// while open and the child is hidden, never destroyed (a remount is costly).
import { useEffect, useId, useLayoutEffect, type RefObject } from 'react'
import { isTauri } from '../houston/host'

export type NativeSuppressionReason =
  | 'grid-hidden'
  | 'collapsed'
  | 'animating'
  | 'non-browser-view'
  | 'popover'
  | 'modal'
  | 'no-active-tab'

export interface SuppressionScope {
  key: string
  rect: () => { x: number; y: number; width: number; height: number } | null
}

export type NativeSuppressionSink = (reason: NativeSuppressionReason, visible: boolean, scope?: SuppressionScope) => void
const scopes = new Map<string, { reason: NativeSuppressionReason; scope: SuppressionScope }>()
export function suppressedScopes(): { reason: NativeSuppressionReason; scope: SuppressionScope }[] {
  return [...scopes.values()]
}

let sink: NativeSuppressionSink | null = null

export function setSuppressionSink(fn: NativeSuppressionSink | null): void {
  sink = fn
}

const counts = new Map<NativeSuppressionReason, number>()

export function assertNativeSuppression(reason: NativeSuppressionReason, scope?: SuppressionScope): void {
  if (scope) {
    scopes.set(scope.key, { reason, scope })
    sink?.(reason, false, scope)
    return
  }
  const next = (counts.get(reason) ?? 0) + 1
  counts.set(reason, next)
  if (next === 1) sink?.(reason, false)
}

export function releaseNativeSuppression(reason: NativeSuppressionReason, scope?: SuppressionScope): void {
  if (scope) {
    if (scopes.delete(scope.key)) sink?.(reason, true, scope)
    return
  }
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
  return counts.size > 0 || scopes.size > 0
}

export function suppressedReasons(): NativeSuppressionReason[] {
  return [...counts.keys()]
}

export function __resetNativeSuppressionForTests(): void {
  counts.clear()
  scopes.clear()
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

export function useNativeOverlaySuppression(
  reason: NativeSuppressionReason,
  active: boolean,
  ref: RefObject<HTMLElement | null>
): void {
  const key = useId()
  useLayoutEffect(() => {
    if (!active || !isTauri()) return
    const scope: SuppressionScope = { key, rect: () => ref.current?.getBoundingClientRect() ?? null }
    const update = (): void => assertNativeSuppression(reason, scope)
    update()
    const observer = new ResizeObserver(update)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      releaseNativeSuppression(reason, scope)
    }
  }, [reason, active, ref, key])
}

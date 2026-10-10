import { useSyncExternalStore } from 'react'

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export type MascotPosition = { kind: 'rail' } | { kind: 'floating'; x: number; y: number }
export const RAIL_POSITION: MascotPosition = { kind: 'rail' }
export const MASCOT_POSITION_KEY = 'tr-mascot-position'
// Match the companion's art size and leave room for window resize grips.
export const FLOATING_SIZE = 64
export const FLOATING_MARGIN = 12

export function readMascotPosition(storage?: Pick<Storage, 'getItem'>): MascotPosition {
  try {
    const value = JSON.parse(storage?.getItem(MASCOT_POSITION_KEY) ?? 'null')
    if (value?.kind === 'floating' && typeof value.x === 'number' && typeof value.y === 'number' &&
      Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1) {
      return { kind: 'floating', x: value.x, y: value.y }
    }
  } catch { /* Invalid or unavailable storage uses the rail. */ }
  return RAIL_POSITION
}
export function writeMascotPosition(storage: Pick<Storage, 'setItem'> | undefined, position: MascotPosition): void {
  try { storage?.setItem(MASCOT_POSITION_KEY, JSON.stringify(position)) }
  catch { /* Position remains usable for this renderer session. */ }
}
export function clampMascotPoint(point: Point, windowSize: Box): Point {
  const marginX = Math.min(FLOATING_MARGIN, Math.max(0, (windowSize.width - FLOATING_SIZE) / 2))
  const marginY = Math.min(FLOATING_MARGIN, Math.max(0, (windowSize.height - FLOATING_SIZE) / 2))
  return {
    x: Math.max(marginX, Math.min(Math.max(marginX, windowSize.width - FLOATING_SIZE - marginX), point.x)),
    y: Math.max(marginY, Math.min(Math.max(marginY, windowSize.height - FLOATING_SIZE - marginY), point.y))
  }
}
export function mascotPositionPoint(position: MascotPosition, windowSize: Box): Point {
  return clampMascotPoint(position.kind === 'floating' ? { x: position.x * windowSize.width, y: position.y * windowSize.height } : { x: 0, y: 0 }, windowSize)
}
export function floatingPosition(point: Point, windowSize: Box): MascotPosition {
  const safe = clampMascotPoint(point, windowSize)
  return { kind: 'floating', x: safe.x / Math.max(1, windowSize.width), y: safe.y / Math.max(1, windowSize.height) }
}
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
export function nearestMascotPoint(point: Point, windowSize: Box, browsers: readonly Box[]): Point | null {
  const desired = clampMascotPoint(point, windowSize)
  if (!browsers.some(browser => boxesIntersect({ ...desired, width: FLOATING_SIZE, height: FLOATING_SIZE }, browser))) return desired
  const limits = clampMascotPoint({ x: windowSize.width, y: windowSize.height }, windowSize)
  const minimum = clampMascotPoint({ x: 0, y: 0 }, windowSize)
  const xs = [desired.x, minimum.x, limits.x, ...browsers.flatMap(box => [box.x - FLOATING_SIZE, box.x + box.width])]
  const ys = [desired.y, minimum.y, limits.y, ...browsers.flatMap(box => [box.y - FLOATING_SIZE, box.y + box.height])]
  let best: Point | null = null, distance = Infinity
  for (const x of xs) for (const y of ys) {
    const candidate = clampMascotPoint({ x, y }, windowSize)
    if (browsers.some(browser => boxesIntersect({ ...candidate, width: FLOATING_SIZE, height: FLOATING_SIZE }, browser))) continue
    const d = (candidate.x - desired.x) ** 2 + (candidate.y - desired.y) ** 2
    if (d < distance) { best = candidate; distance = d }
  }
  return best
}
export function resolveMascotDrop(point: Point, cursor: Point, rail: Box | null, windowSize: Box, browsers: readonly Box[]): MascotPosition {
  const overRail = rail && (boxesIntersect({ ...point, width: FLOATING_SIZE, height: FLOATING_SIZE }, rail) ||
    (cursor.x >= rail.x && cursor.x <= rail.x + rail.width && cursor.y >= rail.y && cursor.y <= rail.y + rail.height))
  if (overRail) return RAIL_POSITION
  const safe = nearestMascotPoint(point, windowSize, browsers)
  return safe ? floatingPosition(safe, windowSize) : RAIL_POSITION
}
let position = readMascotPosition(typeof localStorage === 'undefined' ? undefined : localStorage)
let snapshot = { position, dragging: false }
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
function emit(dragging = snapshot.dragging): void { snapshot = { position, dragging }; listeners.forEach(fn => fn()) }
export const getMascotPosition = (): MascotPosition => position
export function setMascotPosition(next: MascotPosition): void {
  if (position.kind === 'rail' && next.kind === 'rail') return
  // Fraction/pixel round trips should not trigger repeated layout commits.
  if (position.kind === 'floating' && next.kind === 'floating' && Math.abs(position.x - next.x) < 1e-9 && Math.abs(position.y - next.y) < 1e-9) return
  position = next
  writeMascotPosition(typeof localStorage === 'undefined' ? undefined : localStorage, position)
  emit()
}
export function returnMascotToRail(): void { setMascotPosition(RAIL_POSITION) }
export function setMascotDragging(dragging: boolean): void { if (snapshot.dragging !== dragging) emit(dragging) }
export const getMascotPlacement = (): typeof snapshot => snapshot
export const useMascotPlacement = (): typeof snapshot => useSyncExternalStore(subscribe, getMascotPlacement, getMascotPlacement)

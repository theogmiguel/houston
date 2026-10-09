import { clampMascotPoint, resolveMascotDrop, type Box, type MascotPosition, type Point } from './mascotPosition'

// Preserve the existing five-pixel threshold so tapping and rubbing remain distinct from dragging.
export const MASCOT_DRAG_THRESHOLD = 5
interface DragEnvironment {
  point: () => Point
  window: () => Box
  rail: () => Box | null
  browsers: () => readonly Box[]
  move: (point: Point) => void
  dragging: (active: boolean) => void
  save: (position: MascotPosition) => void
  docked: (dx: number, dy: number) => void
  suppressClick: () => void
}
export function createMascotDrag(env: DragEnvironment): {
  start: (cursor: Point) => void
  move: (cursor: Point) => boolean
  end: (cursor: Point) => void
  cancel: (suppressClick?: boolean) => void
} {
  let press: { cursor: Point; origin: Point; moved: boolean; point: Point } | null = null
  return {
    start(cursor) { const origin = env.point(); press = { cursor, origin, point: origin, moved: false } },
    move(cursor) {
      if (!press) return false
      const dx = cursor.x - press.cursor.x, dy = cursor.y - press.cursor.y
      if (!press.moved && Math.hypot(dx, dy) < MASCOT_DRAG_THRESHOLD) return true
      if (!press.moved) { press.moved = true; env.dragging(true) }
      press.point = clampMascotPoint({ x: press.origin.x + dx, y: press.origin.y + dy }, env.window())
      env.move(press.point)
      return true
    },
    end(cursor) {
      const p = press; press = null
      if (!p?.moved) return
      env.suppressClick()
      const point = clampMascotPoint({ x: p.origin.x + cursor.x - p.cursor.x, y: p.origin.y + cursor.y - p.cursor.y }, env.window())
      const position = resolveMascotDrop(point, cursor, env.rail(), env.window(), env.browsers())
      env.save(position)
      env.dragging(false)
      if (position.kind === 'rail') env.docked(cursor.x - p.cursor.x, cursor.y - p.cursor.y)
    },
    cancel(suppressClick = true) {
      const p = press; press = null
      if (!p?.moved) return
      if (suppressClick) env.suppressClick()
      env.move(p.origin)
      env.dragging(false)
    }
  }
}

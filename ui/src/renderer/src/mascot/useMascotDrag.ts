import { useContext, useEffect, useRef, type PointerEvent, type RefObject } from 'react'
import { createMascotDrag } from './mascotDrag'
import { MascotDockContext } from './mascotRailContext'
import { setMascotDragging, setMascotPosition } from './mascotPosition'
import { nativeBrowserSurfaceRects } from '../houston/browserSurfaceRegistry'
import { assertNativeSuppression, releaseNativeSuppression, type SuppressionScope } from '../layout/nativeSuppression'
import { isTauri } from '../houston/host'
import { placeMascotBubble } from './mascotBubble'

export function useMascotDrag(button: RefObject<HTMLButtonElement | null>, onDock: (dx: number, dy: number) => void, suppressClick: () => void): {
  down: (e: PointerEvent<HTMLButtonElement>) => void
  move: (e: PointerEvent<HTMLButtonElement>) => boolean
  up: (e: PointerEvent<HTMLButtonElement>) => void
  cancel: () => void
} {
  const rail = useContext(MascotDockContext)
  const latest = useRef({ rail, onDock, suppressClick }); latest.current = { rail, onDock, suppressClick }
  const scope = useRef<SuppressionScope>({ key: 'mascot-drag', rect: () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }) })
  const active = useRef(false)
  const controller = useRef<ReturnType<typeof createMascotDrag> | null>(null)
  controller.current ??= createMascotDrag({
    point: () => { const box = button.current!.getBoundingClientRect(); return { x: box.left, y: box.top } },
    window: () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }),
    rail: () => latest.current.rail?.getBoundingClientRect() ?? null,
    browsers: nativeBrowserSurfaceRects,
    move: point => {
      const host = button.current?.closest<HTMLElement>('.mascot-host')
      if (host) host.style.transform = `translate(${point.x}px, ${point.y}px)`
      placeMascotBubble(button.current)
    },
    dragging: value => {
      active.current = value
      const host = button.current?.closest<HTMLElement>('.mascot-host')
      if (host) host.dataset.dragging = String(value)
      setMascotDragging(value)
      if (isTauri()) { if (value) assertNativeSuppression('animating', scope.current); else releaseNativeSuppression('animating', scope.current) }
    },
    save: setMascotPosition,
    docked: (dx, dy) => latest.current.onDock(dx, dy),
    suppressClick: () => latest.current.suppressClick()
  })
  useEffect(() => {
    const cancel = (): void => controller.current?.cancel()
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('blur', cancel); if (active.current) controller.current?.cancel(false) }
  }, [])
  const cursor = (e: PointerEvent<HTMLButtonElement>): { x: number; y: number } => ({ x: e.clientX, y: e.clientY })
  return {
    down: e => { if (e.button === 0) { controller.current!.start(cursor(e)); e.currentTarget.setPointerCapture?.(e.pointerId) } },
    move: e => controller.current!.move(cursor(e)),
    up: e => controller.current!.end(cursor(e)),
    cancel: () => controller.current!.cancel()
  }
}

import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import MascotCompanion from './MascotCompanion'
import { MascotDockContext, type MascotRail } from './mascotRailContext'
import { getMascotPlacement, mascotPositionPoint, nearestMascotPoint, floatingPosition, returnMascotToRail, setMascotPosition, useMascotPlacement, type Box } from './mascotPosition'
import { nativeBrowserSurfaceRects, subscribeBrowserSurfaceRects } from '../houston/browserSurfaceRegistry'
import { useMascotLifecycle } from './mascotLifecycle'
import { placeMascotBubble } from './mascotBubble'

export const mascotWindow = (): Box => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
export default function MascotFloatingHost({ rail }: { rail: MascotRail | null }): React.JSX.Element | null {
  const placement = useMascotPlacement()
  const lifecycle = useMascotLifecycle()
  const root = useRef<HTMLDivElement>(null)
  const lastRail = useRef<MascotRail | null>(rail)
  if (rail) lastRail.current = rail
  const visible = placement.position.kind === 'floating' || rail !== null
  useLayoutEffect(() => {
    let frame = 0
    const place = (): void => {
      frame = 0
      const node = root.current, current = getMascotPlacement()
      if (!node || current.dragging) return
      let point
      if (current.position.kind === 'floating') {
        const bounds = mascotWindow()
        point = nearestMascotPoint(mascotPositionPoint(current.position, bounds), bounds, nativeBrowserSurfaceRects())
        if (!point) { returnMascotToRail(); return }
        setMascotPosition(floatingPosition(point, bounds))
      } else {
        const box = rail?.node.querySelector('[data-mascot-dock-anchor]')?.getBoundingClientRect() ?? rail?.node.getBoundingClientRect()
        if (!box) return
        point = { x: box.left, y: box.top }
      }
      node.style.transform = `translate(${point.x}px, ${point.y}px)`
      placeMascotBubble(node.querySelector('button'))
    }
    const queue = (): void => { if (!frame) frame = requestAnimationFrame(place) }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(queue)
    if (rail) observer?.observe(rail.node)
    const unsubscribe = subscribeBrowserSurfaceRects(queue)
    window.addEventListener('resize', queue)
    window.addEventListener('scroll', queue, true)
    place()
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); unsubscribe(); window.removeEventListener('resize', queue); window.removeEventListener('scroll', queue, true) }
  }, [rail, placement.position, placement.dragging, visible])
  if (!visible) return null
  const metadata = lifecycle ?? rail ?? lastRail.current
  return createPortal(<div ref={root} className="mascot-host" data-floating={placement.position.kind === 'floating'} data-dragging={placement.dragging}>
    <MascotDockContext.Provider value={rail?.node ?? null}><MascotCompanion existingUser={metadata?.existingUser ?? false} firstRun={metadata?.firstRun ?? false} /></MascotDockContext.Provider>
  </div>, document.body)
}

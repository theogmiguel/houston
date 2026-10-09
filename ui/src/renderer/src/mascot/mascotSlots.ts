import { useLayoutEffect, useRef } from 'react'
import { getMascotPrefs } from './mascotPrefs'
import { assertNativeSuppression, releaseNativeSuppression, type SuppressionScope } from '../layout/nativeSuppression'
import { isTauri } from '../houston/host'
import { useMascotMotion } from '../components/ui/useMascotMotion'

interface Slot { node: HTMLElement; priority: number; reduced: boolean }
const slots: Slot[] = []
let owner: Slot | undefined
let flight: { node: HTMLElement; animation: Animation; timer: ReturnType<typeof setTimeout>; scope: SuppressionScope; chrome?: HTMLElement } | undefined
export const MASCOT_FLIGHT_MS = 1250

function visual(slot: Slot): HTMLElement {
  return slot.node.querySelector<HTMLElement>('[data-mascot-visual]') ?? slot.node
}
function stopFlight(): void {
  if (!flight) return
  clearTimeout(flight.timer)
  flight.animation.cancel()
  flight.node.remove()
  flight.chrome?.remove()
  if (isTauri()) releaseNativeSuppression('animating', flight.scope)
  flight = undefined
}
function moveTo(next: Slot | undefined): void {
  if (owner === next) return
  const previous = owner
  const source = previous && visual(previous)
  const welcome = previous?.priority === 2 ? previous.node.closest<HTMLElement>('.mascot-welcome') : null
  const welcomeRect = welcome?.getBoundingClientRect()
  const chrome = welcome?.cloneNode(true) as HTMLElement | undefined
  const from = flight?.node.getBoundingClientRect() ?? source?.getBoundingClientRect()
  const copy = (flight?.node ?? source)?.cloneNode(true) as HTMLElement | undefined
  const sourceCanvases = (flight?.node ?? source)?.querySelectorAll('canvas')
  copy?.querySelectorAll('canvas').forEach((canvas, index) => {
    const original = sourceCanvases?.[index]
    if (original) canvas.getContext('2d')?.drawImage(original, 0, 0)
  })
  stopFlight()
  owner = next
  for (const slot of slots) {
    slot.node.style.visibility = slot === next ? 'visible' : 'hidden'
    slot.node.inert = slot !== next
    slot.node.setAttribute('aria-hidden', String(slot !== next))
  }
  previous?.node.style.setProperty('visibility', 'hidden')
  const target = next && visual(next)
  const to = target?.getBoundingClientRect()
  if (!getMascotPrefs().enabled || !next || !copy || !from?.width || !to?.width || next.reduced || previous?.reduced || typeof copy.animate !== 'function') return
  next.node.style.visibility = 'hidden'
  next.node.setAttribute('aria-hidden', 'true')
  next.node.inert = true
  copy.classList.add('mascot-flight')
  copy.style.setProperty('--size', `${from.width}px`)
  copy.querySelector<HTMLElement>('.mascot-rig')?.style.setProperty('--size', `${from.width}px`)
  const pixel = copy.querySelector<HTMLElement>('.mascot-pxwrap')
  if (pixel) { pixel.style.width = `${from.width}px`; pixel.style.height = `${from.width * 44 / 48}px` }
  if (previous?.priority === 2) {
    const rig = copy.querySelector<HTMLElement>('.mascot-rig')
    rig?.classList.forEach(name => { if (name.startsWith('a-')) rig.classList.remove(name) })
    rig?.classList.add('a-work')
  }
  Object.assign(copy.style, { position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, margin: '0', visibility: 'visible', pointerEvents: 'none' })
  copy.setAttribute('aria-hidden', 'true')
  document.body.appendChild(copy)
  if (chrome && welcomeRect) {
    chrome.classList.remove('leaving')
    chrome.querySelector<HTMLElement>('[data-mascot-visual]')?.style.setProperty('visibility', 'hidden')
    chrome.removeAttribute('data-testid')
    chrome.setAttribute('aria-hidden', 'true')
    chrome.inert = true
    Object.assign(chrome.style, { position: 'fixed', inset: 'auto', left: `${welcomeRect.left}px`, top: `${welcomeRect.top}px`, width: `${welcomeRect.width}px`, height: `${welcomeRect.height}px`, pointerEvents: 'none' })
    document.body.appendChild(chrome)
    void chrome.offsetWidth
    chrome.classList.add('leaving')
  }
  const scope: SuppressionScope = { key: 'mascot-flight', rect: () => ({
    x: Math.min(from.left, to.left), y: Math.min(from.top, to.top) - 150,
    width: Math.max(from.right, to.right) - Math.min(from.left, to.left),
    height: Math.max(from.bottom, to.bottom) - Math.min(from.top, to.top) + 150
  }) }
  if (isTauri()) assertNativeSuppression('animating', scope)
  const dx = to.left + to.width / 2 - from.left - from.width / 2
  const dy = to.top + to.height / 2 - from.top - from.height / 2
  const scale = to.width / from.width
  const animation = copy.animate([
    { transform: 'none', opacity: 1 },
    { transform: 'translate(0, -24px) scale(1.06)', offset: .14 },
    { transform: `translate(${dx * .5}px, ${dy * .5 - 150}px) scale(${(1 + scale) / 2}) rotate(-14deg)`, offset: .55 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1 }
  ], { duration: MASCOT_FLIGHT_MS, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' })
  const finish = (): void => {
    if (flight?.animation !== animation) return
    stopFlight()
    if (owner === next) { next.node.style.visibility = 'visible'; next.node.setAttribute('aria-hidden', 'false'); next.node.inert = false }
  }
  // WebKit animation completion must never gate actions or leave the destination hidden.
  flight = { node: copy, animation, timer: setTimeout(finish, MASCOT_FLIGHT_MS), scope, chrome }
  animation.onfinish = finish
}
function preferredSlot(): Slot | undefined {
  return slots.reduce<Slot | undefined>((best, slot) => !best || slot.priority >= best.priority ? slot : best, undefined)
}
export function registerMascotSlot(node: HTMLElement, priority: number, reduced: boolean): () => void {
  node.dataset.mascotSlot = String(priority)
  const slot = { node, priority, reduced }
  slots.push(slot)
  moveTo(preferredSlot())
  if (owner !== slot) { node.style.visibility = 'hidden'; node.inert = true; node.setAttribute('aria-hidden', 'true') }
  return () => {
    slots.splice(slots.indexOf(slot), 1)
    moveTo(preferredSlot())
  }
}
export function useMascotSlot(priority: number): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const { reduced } = useMascotMotion()
  useLayoutEffect(() => {
    if (ref.current) return registerMascotSlot(ref.current, priority, reduced)
  }, [priority, reduced])
  return ref
}

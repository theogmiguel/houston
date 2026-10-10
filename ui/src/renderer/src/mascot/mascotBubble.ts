import { FLOATING_MARGIN } from './mascotPosition'

export function placeMascotBubble(button: HTMLButtonElement | null): void {
  const bubble = button?.querySelector<HTMLElement>('.bubble')
  if (!button || !bubble) return
  const host = button.closest<HTMLElement>('.mascot-host')
  if (host?.dataset.floating !== 'true' && host?.dataset.dragging !== 'true') {
    bubble.style.left = ''; bubble.style.top = ''; bubble.style.bottom = ''
    delete bubble.dataset.side
    return
  }
  const box = button.getBoundingClientRect(), width = bubble.offsetWidth, height = bubble.offsetHeight
  let x = box.right + 10
  const left = x + width > window.innerWidth - FLOATING_MARGIN
  if (left) x = box.left - width - 10
  x = Math.max(FLOATING_MARGIN, Math.min(window.innerWidth - width - FLOATING_MARGIN, x))
  const y = Math.max(FLOATING_MARGIN, Math.min(window.innerHeight - height - FLOATING_MARGIN, box.top + box.height * .28 - height))
  bubble.style.left = `${x - box.left}px`
  bubble.style.top = `${y - box.top}px`
  bubble.style.bottom = 'auto'
  bubble.dataset.side = left ? 'left' : 'right'
}

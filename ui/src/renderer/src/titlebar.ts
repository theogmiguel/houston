const NO_DRAG_SELECTOR = '.\\[-webkit-app-region\\:no-drag\\]'

export function isTitlebarDragEligible(e: {
  button: number
  detail: number
  target: EventTarget | null
}): boolean {
  if (e.button !== 0) return false
  if (e.detail >= 2) return false
  const target = e.target
  if (!(target instanceof Element)) return true
  return target.closest(NO_DRAG_SELECTOR) === null
}

export function isBareTitlebarTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  return target.closest(NO_DRAG_SELECTOR) === null
}

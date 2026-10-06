import { flushSync } from 'react-dom'

export const THEME_REVEAL_DURATION_MS = 400

export interface ThemeRevealOrigin {
  left: number
  top: number
  width: number
  height: number
}

export function themeRevealRadius(
  origin: ThemeRevealOrigin,
  viewport: { width: number; height: number }
): number {
  const x = origin.left + origin.width / 2
  const y = origin.top + origin.height / 2
  return Math.ceil(Math.hypot(Math.max(x, viewport.width - x), Math.max(y, viewport.height - y)))
}

export function revealThemeFromClick(
  origin: Element | null,
  update: () => void,
  duration = THEME_REVEAL_DURATION_MS
): void {
  if (!origin) {
    update()
    return
  }

  const viewTransitionDocument = document as Document & {
    startViewTransition?: (updateCallback: () => void) => { ready: Promise<void> }
  }
  const rect = origin.getBoundingClientRect()
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const startViewTransition = viewTransitionDocument.startViewTransition

  if (reducedMotion || !startViewTransition) {
    update()
    return
  }

  const radius = themeRevealRadius(rect, viewport)
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const transition = startViewTransition.call(document, () => flushSync(update))
  void transition.ready.then(() => {
    const root = document.documentElement
    const easing = getComputedStyle(root).getPropertyValue('--motion-panel-ease').trim()
    root.animate(
      [
        { clipPath: `circle(0px at ${x}px ${y}px)` },
        { clipPath: `circle(${radius}px at ${x}px ${y}px)` }
      ],
      {
        duration,
        easing,
        pseudoElement: '::view-transition-new(root)'
      }
    )
  }).catch(() => {})
}

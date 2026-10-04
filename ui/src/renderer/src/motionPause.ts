export function watchMotionPause(): () => void {
  const root = document.documentElement
  let blurTimer: ReturnType<typeof setTimeout> | undefined
  const update = (): void => {
    root.toggleAttribute('data-motion-paused', document.visibilityState === 'hidden' || !document.hasFocus())
  }
  const onBlur = (): void => { blurTimer = setTimeout(update, 500) }
  const onFocus = (): void => { clearTimeout(blurTimer); update() }
  update()
  document.addEventListener('visibilitychange', update)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  return () => {
    clearTimeout(blurTimer)
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
  }
}

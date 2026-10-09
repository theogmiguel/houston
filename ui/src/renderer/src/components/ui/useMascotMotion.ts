import { useEffect, useState } from 'react'
export function useMascotMotion(background = false): { reduced: boolean; paused: boolean } {
  const [motion, setMotion] = useState(() => ({ reduced: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, paused: document.hidden || (!background && !document.hasFocus()) }))
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = (): void => setMotion({ reduced: media?.matches ?? false, paused: document.hidden || (!background && !document.hasFocus()) })
    media?.addEventListener('change', update); document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update); window.addEventListener('blur', update); update()
    return () => { media?.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); window.removeEventListener('blur', update) }
  }, [background])
  return motion
}

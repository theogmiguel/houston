import { useEffect, useRef, useState, type JSX } from 'react'
import { useBackgroundState } from '../backgroundMode'
import { renderBackdrop } from './index'
import { loadBackgroundSource, sourceFor, USER_IMAGE, type LoadedSource } from './source'
import type { DitherParams } from './types'

type CustomBackdropProps = {
  theme: string
  className?: string
  onUnavailable?: (reason: string) => void
}

export function CustomBackdrop({
  theme,
  className = '',
  onUnavailable
}: CustomBackdropProps): JSX.Element | null {
  const bg = useBackgroundState()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastFiredReason = useRef<string | null>(null)
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  const [viewport, setViewport] = useState<{ width: number; height: number; dpr: number }>(
    () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    })
  )

  useEffect(() => {
    const measure = (): void => {
      setViewport((prev) => {
        const next = {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1
        }
        return prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr
          ? prev
          : next
      })
    }
    window.addEventListener('resize', measure)
    const dprQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
        : null
    dprQuery?.addEventListener('change', measure)
    return () => {
      window.removeEventListener('resize', measure)
      dprQuery?.removeEventListener('change', measure)
    }
  }, [])

  const dark = theme === 'graphite'
  const source = sourceFor(bg.preset)
  const sourceKey = source.kind === 'preset' ? `preset:${source.id}` : `${USER_IMAGE}:${bg.imageVersion}`

  const [loaded, setLoaded] = useState<LoadedSource | null>(null)

  useEffect(() => {
    if (bg.mode !== 'custom') return
    let live = true
    void loadBackgroundSource(source).then((result) => {
      if (!live) return
      if (!result) {
        setLoaded(null)
        const reason = source.kind === 'preset' ? `preset ${source.id}` : 'your image'
        if (lastFiredReason.current === reason) return
        lastFiredReason.current = reason
        onUnavailableRef.current?.(reason)
        return
      }
      lastFiredReason.current = null
      setLoaded(result)
    })
    return () => {
      live = false
    }
  }, [bg.mode, sourceKey])

  useEffect(() => {
    if (bg.mode !== 'custom' || !loaded) return
    const canvas = canvasRef.current
    if (!canvas) return
    const params: DitherParams = {
      pixelSize: bg.pixelSize,
      colorSteps: bg.colorSteps,
      originalColors: bg.originalColors,
      ceiling: bg.ceiling,
      dark
    }
    renderBackdrop(canvas, loaded.bitmap, viewport, params)
  }, [
    bg.mode,
    loaded,
    bg.pixelSize,
    bg.colorSteps,
    bg.originalColors,
    bg.ceiling,
    dark,
    viewport
  ])

  if (bg.mode !== 'custom') return null

  return (
    <div
      data-testid="custom-backdrop"
      aria-hidden
      className={`fixed inset-0 z-[var(--z-backdrop)] pointer-events-none ${className}`}
    >
      <canvas
        ref={canvasRef}
        data-testid="custom-backdrop-canvas"
        className="absolute inset-0 h-full w-full"
        style={{ opacity: bg.fieldOpacity / 100, imageRendering: 'pixelated' }}
      />
      <div
        data-testid="custom-backdrop-fade"
        className="absolute inset-0"
        style={{
          background: `linear-gradient(to bottom, transparent ${bg.fadeStop}%, var(--material-shell-bg) 100%)`
        }}
      />
    </div>
  )
}

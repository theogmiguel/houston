import { useEffect, useRef, useState, type JSX } from 'react'
import { useBackgroundState } from '../../backgroundMode'
import { loadBackgroundSource, sourceFor, USER_IMAGE } from '../../backdrop/source'
import type { ChromeTheme, TerminalPalette } from '../../theme'
import { BackgroundFieldPreview, BackgroundThumbnail } from '../ui/BackgroundField'

let enginePromise: Promise<typeof import('../../backdrop/engine')> | null = null
function engine(): Promise<typeof import('../../backdrop/engine')> {
  enginePromise ??= import('../../backdrop/engine')
  return enginePromise
}

type Decoded = ImageBitmap | HTMLImageElement
type FieldState = { kind: 'loading' } | { kind: 'ready'; source: Decoded } | { kind: 'missing' }

function useDecodedSource(preset: string): FieldState {
  const [state, setState] = useState<FieldState>({ kind: 'loading' })
  const cache = useRef(new Map<string, Decoded>())
  const { imageVersion } = useBackgroundState()

  useEffect(() => {
    const key = preset === USER_IMAGE ? `${USER_IMAGE}:${imageVersion}` : `preset:${preset}`
    if (preset === USER_IMAGE) {
      for (const [k, v] of cache.current) {
        if (k.startsWith(`${USER_IMAGE}:`) && k !== key) {
          if ('close' in v) v.close()
          cache.current.delete(k)
        }
      }
    }
    const hit = cache.current.get(key)
    if (hit) {
      setState({ kind: 'ready', source: hit })
      return
    }
    let live = true
    setState({ kind: 'loading' })
    void loadBackgroundSource(sourceFor(preset)).then((result) => {
      if (!live) return
      if (!result) {
        setState({ kind: 'missing' })
        return
      }
      cache.current.set(key, result.bitmap)
      setState({ kind: 'ready', source: result.bitmap })
    })
    return () => { live = false }
  }, [preset, imageVersion])

  return state
}

function useFieldPaint(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  state: FieldState,
  dark: boolean
): void {
  const bg = useBackgroundState()

  useEffect(() => {
    if (state.kind !== 'ready') return
    const canvas = canvasRef.current
    if (!canvas) return
    let live = true
    void engine().then(({ renderField }) => {
      if (!live) return
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      renderField(canvas, state.source, { width, height, dpr: window.devicePixelRatio || 1 }, {
        pixelSize: bg.pixelSize,
        colorSteps: bg.colorSteps,
        originalColors: bg.originalColors,
        ceiling: bg.ceiling,
        dark
      })
    })
    return () => { live = false }
  }, [canvasRef, state, dark, bg.pixelSize, bg.colorSteps, bg.originalColors, bg.ceiling])
}

export function BackgroundPreview({ chromeTheme, palette }: { chromeTheme: ChromeTheme; palette: TerminalPalette }): JSX.Element {
  const bg = useBackgroundState()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const state = useDecodedSource(bg.preset)
  useFieldPaint(canvasRef, state, chromeTheme === 'graphite')
  const missingMessage = bg.preset === USER_IMAGE
    ? 'No image is set on this channel yet — choose one below.'
    : 'This preset could not be loaded.'

  return <BackgroundFieldPreview canvasRef={canvasRef} palette={palette} state={state.kind} opacity={bg.fieldOpacity} fadeStop={bg.fadeStop} missingMessage={missingMessage} />
}

export function PresetThumb({ preset, dark }: { preset: string; dark: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const state = useDecodedSource(preset)
  useFieldPaint(canvasRef, state, dark)
  return <BackgroundThumbnail canvasRef={canvasRef} state={state.kind} />
}

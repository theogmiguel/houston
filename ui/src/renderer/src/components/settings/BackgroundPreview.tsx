import { useEffect, useRef, useState, type JSX } from 'react'
import { useBackgroundState } from '../../backgroundMode'
import { loadBackgroundSource, sourceFor, USER_IMAGE } from '../../backdrop/source'
import type { ChromeTheme, TerminalPalette } from '../../theme'

let enginePromise: Promise<typeof import('../../backdrop/engine')> | null = null
function engine(): Promise<typeof import('../../backdrop/engine')> {
  enginePromise ??= import('../../backdrop/engine')
  return enginePromise
}

type Decoded = ImageBitmap | HTMLImageElement

type FieldState =
  | { kind: 'loading' }
  | { kind: 'ready'; source: Decoded }
  | { kind: 'missing' }

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
    return () => {
      live = false
    }
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
      renderField(
        canvas,
        state.source,
        { width, height, dpr: window.devicePixelRatio || 1 },
        {
          pixelSize: bg.pixelSize,
          colorSteps: bg.colorSteps,
          originalColors: bg.originalColors,
          ceiling: bg.ceiling,
          dark
        }
      )
    })
    return () => {
      live = false
    }
  }, [canvasRef, state, dark, bg.pixelSize, bg.colorSteps, bg.originalColors, bg.ceiling])
}

function MiniShell({ palette }: { palette: TerminalPalette }): JSX.Element {
  const bar = 'block h-[4px] rounded-[var(--tr-radius-pill)]'
  const line = 'block h-[3px] rounded-[var(--tr-radius-pill)]'
  return (
    <div
      aria-hidden
      className="absolute inset-0 grid"
      style={{
        gridTemplateColumns: '21% minmax(0, 1fr)',
        gridTemplateRows: '13% minmax(0, 1fr)',
        gridTemplateAreas: '"rail top" "rail grid"'
      }}
    >
      <div
        className="[grid-area:rail] flex flex-col gap-[5px] p-[8px]"
        style={{ background: 'var(--custom-chrome-scrim)' }}
      >
        <span className={bar} style={{ background: 'var(--text-primary)', opacity: 0.75, width: '70%' }} />
        <span className={bar} style={{ background: 'var(--custom-text-muted)', width: '55%' }} />
        <span className={bar} style={{ background: 'var(--custom-text-muted)', width: '80%' }} />
        <span className={bar} style={{ background: 'var(--custom-text-faint)', width: '42%' }} />
        <span className={bar} style={{ background: 'var(--custom-text-faint)', width: '64%' }} />
      </div>
      <div className="[grid-area:top]" style={{ background: 'var(--custom-chrome-scrim)' }} />
      {}
      <div className="[grid-area:grid] flex gap-[7px] p-[7px]">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex-1 flex flex-col overflow-hidden rounded-[var(--tr-radius-input)] border"
            style={{ background: 'var(--custom-pane-scrim)', borderColor: 'var(--glass-brd)' }}
          >
            <span
              className="block h-[11px] flex-none border-b"
              style={{
                background: 'var(--session-terminal-header-bg)',
                borderColor: 'var(--divider)'
              }}
            />
            <span className="flex flex-col gap-[4px] p-[6px]">
              <i className={line} style={{ background: palette.foreground, width: i ? '68%' : '84%' }} />
              <i className={line} style={{ background: palette.brightBlack, width: i ? '84%' : '62%' }} />
              <i className={line} style={{ background: palette.foreground, width: '45%' }} />
              <i className={line} style={{ background: palette.brightBlack, width: i ? '52%' : '71%' }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BackgroundPreview({
  chromeTheme,
  palette
}: {
  chromeTheme: ChromeTheme
  palette: TerminalPalette
}): JSX.Element {
  const bg = useBackgroundState()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const state = useDecodedSource(bg.preset)
  useFieldPaint(canvasRef, state, chromeTheme === 'graphite')

  return (
    <div
      data-testid="background-preview"
      data-field={state.kind}
      className="relative overflow-hidden rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--content-bg)]"
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        data-testid="background-preview-canvas"
        className="block w-full [aspect-ratio:16/9]"
        style={{ opacity: bg.fieldOpacity / 100, imageRendering: 'pixelated' }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `linear-gradient(to bottom, transparent ${bg.fadeStop}%, var(--rail-bg) 100%)`
        }}
      />
      <MiniShell palette={palette} />
      {state.kind === 'missing' && (
        <p
          data-testid="background-preview-missing"
          className="absolute inset-0 m-0 flex items-center justify-center bg-[var(--content-bg)] px-[var(--space-4)] text-center text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]"
        >
          {bg.preset === USER_IMAGE
            ? 'No image is set on this channel yet — choose one below.'
            : 'This preset could not be loaded.'}
        </p>
      )}
    </div>
  )
}

export function PresetThumb({
  preset,
  dark
}: {
  preset: string
  dark: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const state = useDecodedSource(preset)
  useFieldPaint(canvasRef, state, dark)

  return (
    <span
      data-testid="background-preset-thumb"
      data-field={state.kind}
      className="relative block w-full bg-[var(--content-bg)]"
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="block w-full [aspect-ratio:16/10]"
        style={{ imageRendering: 'pixelated' }}
      />
      {state.kind !== 'ready' && (
        <span className="absolute inset-0 flex items-center justify-center text-[length:var(--tr-text-small-size)] text-[var(--text-faint)]">
          {state.kind === 'missing' ? 'Not set' : ''}
        </span>
      )}
    </span>
  )
}

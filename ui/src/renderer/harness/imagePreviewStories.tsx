import React, { useEffect } from 'react'
import { ImagePreview } from '../src/components/MediaPreview'

/** A 1280 × 800 screenshot-like image with fine text, so fit and zoomed captures differ visibly. */
function screenshotBytes(): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 800
  const context = canvas.getContext('2d')!
  context.fillStyle = '#16181d'
  context.fillRect(0, 0, 1280, 800)
  context.fillStyle = '#23262e'
  context.fillRect(0, 0, 1280, 36)
  for (const [x, colour] of [[18, '#ff5f57'], [38, '#febc2e'], [58, '#28c840']] as const) {
    context.fillStyle = colour
    context.beginPath()
    context.arc(x, 18, 6, 0, Math.PI * 2)
    context.fill()
  }
  context.font = '13px monospace'
  const lines = ['$ cargo nextest run -p houston-core --test it image', '   Compiling houston-core v0.1.1', '    Finished test profile in 41.2s', '    Starting 3 tests across 1 binary', '        PASS [   0.412s] it::preview::image_fits', '        PASS [   0.388s] it::preview::image_zooms_around_cursor', '        FAIL [   0.091s] it::preview::image_pans_when_zoomed', '  assertion failed: scroll.left == 412 (actual 408)']
  lines.forEach((line, index) => {
    context.fillStyle = line.includes('FAIL') || line.includes('assertion') ? '#ff7b72' : line.includes('PASS') ? '#7ee787' : '#c9d1d9'
    context.fillText(line, 24, 72 + index * 22)
  })
  context.strokeStyle = '#30363d'
  context.strokeRect(24, 280, 1232, 496)
  for (let x = 0; x < 30; x++) {
    context.fillStyle = `hsl(${200 + x * 4} 60% ${30 + (x % 5) * 8}%)`
    context.fillRect(40 + x * 40, 760 - (x * 37) % 420, 28, (x * 37) % 420)
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? void blob.arrayBuffer().then(resolve) : reject(new Error('canvas.toBlob returned null'))), 'image/png'))
}

function driveZoom(frame: string, act: (viewport: HTMLElement) => void): () => void {
  let attempts = 0
  const timer = window.setInterval(() => {
    const viewport = document.querySelector<HTMLElement>(`[data-story-frame="${frame}"] [data-testid="image-zoom-viewport"]`)
    const canvas = viewport?.firstElementChild as HTMLElement | null | undefined
    if (viewport && canvas?.style.width) {
      act(viewport)
      window.clearInterval(timer)
    } else if (++attempts > 100) window.clearInterval(timer)
  }, 10)
  return () => window.clearInterval(timer)
}

function ImagePreviewZoomFrames(): React.JSX.Element {
  const [ready, setReady] = React.useState(false)
  useEffect(() => {
    const host = window as unknown as { __TAURI_INTERNALS__?: object }
    const previousTauri = host.__TAURI_INTERNALS__
    const bytes = screenshotBytes()
    host.__TAURI_INTERNALS__ = { invoke: async () => (await bytes).slice(0) }
    setReady(true)
    return () => {
      if (previousTauri !== undefined) host.__TAURI_INTERNALS__ = previousTauri
      else delete host.__TAURI_INTERNALS__
    }
  }, [])
  useEffect(() => {
    if (!ready) return
    const stopActual = driveZoom('actual', (viewport) => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true })))
    const stopDeep = driveZoom('deep', (viewport) => {
      const bounds = viewport.getBoundingClientRect()
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1100, clientX: bounds.left + 150, clientY: bounds.top + 62, bubbles: true, cancelable: true }))
    })
    return () => {
      stopActual()
      stopDeep()
    }
  }, [ready])
  const frame = (name: string): React.JSX.Element => (
    <div data-story-frame={name} style={{ position: 'relative', width: 560, height: 360, border: '1px solid var(--border)', background: 'var(--content-bg)' }}>
      {ready && <ImagePreview filePath={`/workspace/${name}.png`} />}
    </div>
  )
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 560px)', gap: 16, padding: 24, color: 'var(--text-primary)', background: 'var(--background)' }}>
    <style>{'html body *:not(style):not(script) { animation: none !important; transition: none !important; }'}</style>
    {frame('fit')}
    {frame('actual')}
    {frame('deep')}
  </div>
}

export function ImagePreviewZoomStory(): React.JSX.Element { return <ImagePreviewZoomFrames /> }

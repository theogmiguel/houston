import type { DitherParams } from './types'
import type { FieldSize } from './engine'
import { SETTLE_MS } from '../houston/browserGeometry'

let engineModulePromise: Promise<typeof import('./engine')> | null = null
function engineModule(): Promise<typeof import('./engine')> {
  engineModulePromise ??= import('./engine')
  return engineModulePromise
}

type Pending = {
  canvas: HTMLCanvasElement
  source: ImageBitmap | HTMLImageElement
  size: FieldSize
  params: DitherParams
  gen: number
}

let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0

// Single trailing debounce, not the layout ladder's later rungs: a caller
// whose layout is still settling re-triggers this itself, and the generation
// token drops whatever a superseded call had in flight.
export function renderBackdrop(
  canvas: HTMLCanvasElement,
  source: ImageBitmap | HTMLImageElement,
  size: FieldSize,
  params: DitherParams
): void {
  const commit: Pending = { canvas, source, size, params, gen: ++generation }
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void run(commit)
  }, SETTLE_MS[0])
}

async function run(p: Pending): Promise<void> {
  if (p.gen !== generation) return
  const { renderField } = await engineModule()
  if (p.gen !== generation) return
  renderField(p.canvas, p.source, p.size, p.params)
}
